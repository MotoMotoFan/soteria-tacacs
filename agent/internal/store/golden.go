package store

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// The golden config is a protected baseline snapshot of the managed
// files. It lives outside backups/ so retention pruning never touches
// it, and overwriting it is restricted to administrators (enforced at
// the API layer via the JWT role claim when auth is enabled).

func (s *Store) goldenDir() string { return filepath.Join(s.Dir, "golden") }

// GoldenInfo describes the stored golden config.
type GoldenInfo struct {
	Exists  bool   `json:"exists"`
	SavedAt string `json:"savedAt,omitempty"`
	Files   int    `json:"files,omitempty"`
	Size    string `json:"size,omitempty"`
}

func (s *Store) Golden() GoldenInfo {
	fi, err := os.Stat(s.goldenDir())
	if err != nil || !fi.IsDir() {
		return GoldenInfo{Exists: false}
	}
	info := GoldenInfo{Exists: true, SavedAt: fi.ModTime().UTC().Format(time.RFC3339)}
	var size int64
	_ = filepath.Walk(s.goldenDir(), func(_ string, f os.FileInfo, err error) error {
		if err == nil && !f.IsDir() {
			size += f.Size()
			info.Files++
		}
		return nil
	})
	info.Size = humanSize(size)
	return info
}

// SaveGolden snapshots the current LIVE config as the golden baseline,
// replacing any previous golden config.
func (s *Store) SaveGolden() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tmp := s.goldenDir() + ".tmp"
	if err := os.RemoveAll(tmp); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(tmp, "conf.d"), 0o750); err != nil {
		return err
	}
	for _, rel := range ManagedFiles {
		b, err := os.ReadFile(s.path(rel))
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return err
		}
		if err := writeFile0640(filepath.Join(tmp, filepath.FromSlash(rel)), b); err != nil {
			return err
		}
	}
	if err := os.RemoveAll(s.goldenDir()); err != nil {
		return err
	}
	return os.Rename(tmp, s.goldenDir())
}

// RestoreGolden applies the golden baseline through the usual pipeline:
// snapshot current state first, copy golden files in, validate, reload.
// Rejected while an edit session is open.
func (s *Store) RestoreGolden(ctx context.Context) (string, error) {
	if s.StagingActive() {
		return "", fmt.Errorf("an edit session is open — commit or discard it before restoring the golden config")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if fi, err := os.Stat(s.goldenDir()); err != nil || !fi.IsDir() {
		return "", fmt.Errorf("no golden config saved yet")
	}

	preID, err := s.snapshotLocked()
	if err != nil {
		return "", fmt.Errorf("snapshotting current config before golden restore: %w", err)
	}
	if err := s.copySnapshotLocked(s.goldenDir()); err != nil {
		return "", fmt.Errorf("restoring golden config: %w", err)
	}

	if s.DevMode {
		s.pruneBackupsLocked()
		return "dev mode: validation and reload skipped", nil
	}
	out, err := s.Validate.ValidateConfig(ctx)
	if err != nil {
		if rbErr := s.copySnapshotLocked(filepath.Join(s.backupsDir(), preID)); rbErr != nil {
			return out, fmt.Errorf("golden config invalid AND rollback failed: %v / %v", err, rbErr)
		}
		return out, fmt.Errorf("golden config failed validation, previous config kept: %w", err)
	}
	if err := s.Reload.ReloadTacacs(ctx); err != nil {
		return out, fmt.Errorf("golden restored and valid, but reload failed: %w", err)
	}
	s.pruneBackupsLocked()
	return out, nil
}

// GoldenDiffs returns unified diffs (golden -> live) so the UI can show
// drift from the baseline.
func (s *Store) GoldenDiffs() []FileDiff {
	diffs := []FileDiff{}
	if fi, err := os.Stat(s.goldenDir()); err != nil || !fi.IsDir() {
		return diffs
	}
	for _, rel := range ManagedFiles {
		golden, err := os.ReadFile(filepath.Join(s.goldenDir(), filepath.FromSlash(rel)))
		if err != nil {
			continue
		}
		live, _ := os.ReadFile(s.path(rel))
		if d := UnifiedDiff(string(golden), string(live)); d != "" {
			diffs = append(diffs, FileDiff{File: rel, Diff: d})
		}
	}
	return diffs
}
