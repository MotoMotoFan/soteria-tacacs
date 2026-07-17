package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Staged-commit workflow: entering edit mode copies the entity files into
// staging/; entity PUTs write there; reads overlay staging on live; commit
// snapshots the live config, moves everything staged into place, validates
// via the server container and reloads — one backup per commit, so global
// rollback = restore the newest backup.

// EntityFiles are the config files managed through the staging workflow.
var EntityFiles = []string{MainFile, LoggingFile, DNSFile, MavisFile, DevicesFile, UsersFile, GroupsFile, ProfilesFile, RulesetFile, TLSFile, OverridesFile}

// RestartFiles need a container restart to apply (not just SIGHUP): the main
// config's listeners, the TLS include, and the entrypoint overrides file.
var RestartFiles = map[string]bool{MainFile: true, TLSFile: true, OverridesFile: true}

// ErrStagingInactive is returned when a write arrives outside edit mode.
var ErrStagingInactive = errors.New("config edit mode is not active — enter Edit Config mode first")

const DefaultRetention = 5

func (s *Store) stagingDir() string    { return filepath.Join(s.Dir, "staging") }
func (s *Store) settingsPath() string  { return filepath.Join(s.Dir, ".agent.json") }

func isEntityFile(rel string) bool {
	for _, f := range EntityFiles {
		if f == rel {
			return true
		}
	}
	return false
}

func (s *Store) restartMarkerPath() string { return filepath.Join(s.stagingDir(), ".needs-restart") }

// MarkRestart flags the current edit session as requiring a container
// restart on commit (set when a restart-group setting is staged).
func (s *Store) MarkRestart() error {
	return writeFile0640(s.restartMarkerPath(), []byte("1"))
}

func (s *Store) restartMarked() bool {
	_, err := os.Stat(s.restartMarkerPath())
	return err == nil
}

// RestartPending reports whether the open edit session will restart the
// container on commit (a restart-group setting was staged).
func (s *Store) RestartPending() bool { return s.restartMarked() }

// StagingActive reports whether an edit session is open.
func (s *Store) StagingActive() bool {
	fi, err := os.Stat(s.stagingDir())
	return err == nil && fi.IsDir()
}

// BeginStaging opens an edit session (no-op if one is already open, so a
// second browser tab doesn't wipe pending edits).
func (s *Store) BeginStaging() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.StagingActive() {
		return nil
	}
	for _, rel := range EntityFiles {
		b, err := os.ReadFile(s.path(rel))
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return err
		}
		if err := writeFile0640(filepath.Join(s.stagingDir(), filepath.FromSlash(rel)), b); err != nil {
			return err
		}
	}
	return nil
}

// DiscardStaging drops all staged edits.
func (s *Store) DiscardStaging() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return os.RemoveAll(s.stagingDir())
}

// ChangedFiles lists entity files whose staged content differs from live.
func (s *Store) ChangedFiles() []string {
	changed := []string{}
	if !s.StagingActive() {
		return changed
	}
	for _, rel := range EntityFiles {
		staged, err := os.ReadFile(filepath.Join(s.stagingDir(), filepath.FromSlash(rel)))
		if err != nil {
			continue
		}
		live, _ := os.ReadFile(s.path(rel))
		if string(staged) != string(live) {
			changed = append(changed, rel)
		}
	}
	return changed
}

// ReadEffective returns the staged content when an edit session is open
// and has this file, the live content otherwise.
func (s *Store) ReadEffective(rel string) (string, error) {
	if !isManaged(rel) {
		return "", fmt.Errorf("not a managed config file: %s", rel)
	}
	if s.StagingActive() && isEntityFile(rel) {
		if b, err := os.ReadFile(filepath.Join(s.stagingDir(), filepath.FromSlash(rel))); err == nil {
			return string(b), nil
		}
	}
	b, err := os.ReadFile(s.path(rel))
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// WriteStaged stores rendered entity config in the staging area. Nothing
// touches the live config until CommitStaging.
func (s *Store) WriteStaged(rel, content string) error {
	if !isEntityFile(rel) {
		return fmt.Errorf("not a staged config file: %s", rel)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.StagingActive() {
		return ErrStagingInactive
	}
	return writeFile0640(filepath.Join(s.stagingDir(), filepath.FromSlash(rel)), []byte(content))
}

// FileDiff describes pending changes for one file.
type FileDiff struct {
	File string `json:"file"`
	Diff string `json:"diff"`
}

// StagedDiffs returns unified diffs (live -> staged) for all changed files.
func (s *Store) StagedDiffs() []FileDiff {
	diffs := []FileDiff{}
	for _, rel := range s.ChangedFiles() {
		live, _ := os.ReadFile(s.path(rel))
		staged, _ := os.ReadFile(filepath.Join(s.stagingDir(), filepath.FromSlash(rel)))
		diffs = append(diffs, FileDiff{File: rel, Diff: UnifiedDiff(string(live), string(staged))})
	}
	return diffs
}

// BackupDiff returns unified diffs (live -> backup: what restoring would
// change). files empty = all managed files; only changed files are returned.
func (s *Store) BackupDiff(backupID string, files []string) ([]FileDiff, error) {
	if strings.ContainsAny(backupID, `/\.`) {
		return nil, fmt.Errorf("invalid backup id")
	}
	srcDir := filepath.Join(s.backupsDir(), backupID)
	if fi, err := os.Stat(srcDir); err != nil || !fi.IsDir() {
		return nil, fmt.Errorf("backup %s not found", backupID)
	}
	if len(files) == 0 {
		files = ManagedFiles
	}
	diffs := []FileDiff{}
	for _, rel := range files {
		if !isManaged(rel) {
			return nil, fmt.Errorf("not a managed config file: %s", rel)
		}
		backup, err := os.ReadFile(filepath.Join(srcDir, filepath.FromSlash(rel)))
		if err != nil {
			continue // file absent from this backup
		}
		live, _ := os.ReadFile(s.path(rel))
		if d := UnifiedDiff(string(live), string(backup)); d != "" {
			diffs = append(diffs, FileDiff{File: rel, Diff: d})
		}
	}
	return diffs, nil
}

// CommitStaging applies all staged edits atomically: snapshot live config,
// copy staged files into place, validate inside the server container,
// SIGHUP reload. Validation failure restores the pre-commit files and
// KEEPS the staging session so the user can fix and retry.
func (s *Store) CommitStaging(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.StagingActive() {
		return "", ErrStagingInactive
	}

	var changed []string
	for _, rel := range EntityFiles {
		staged, err := os.ReadFile(filepath.Join(s.stagingDir(), filepath.FromSlash(rel)))
		if err != nil {
			continue
		}
		live, _ := os.ReadFile(s.path(rel))
		if string(staged) != string(live) {
			changed = append(changed, rel)
		}
	}
	if len(changed) == 0 {
		_ = os.RemoveAll(s.stagingDir())
		return "no changes to commit", nil
	}

	backupID, err := s.snapshotLocked()
	if err != nil {
		return "", fmt.Errorf("creating backup: %w", err)
	}

	for _, rel := range changed {
		b, err := os.ReadFile(filepath.Join(s.stagingDir(), filepath.FromSlash(rel)))
		if err != nil {
			return "", fmt.Errorf("reading staged %s: %w", rel, err)
		}
		if err := writeFile0640(s.path(rel), b); err != nil {
			return "", fmt.Errorf("writing %s: %w", rel, err)
		}
	}

	if s.DevMode {
		_ = os.RemoveAll(s.stagingDir())
		s.pruneBackupsLocked()
		return "dev mode: validation and reload skipped", nil
	}

	out, err := s.Validate.ValidateConfig(ctx)
	if err != nil {
		// Put the pre-commit files back; keep staging for fixing.
		restoreErr := s.restoreFilesLocked(filepath.Join(s.backupsDir(), backupID), changed)
		_ = os.RemoveAll(filepath.Join(s.backupsDir(), backupID))
		if restoreErr != nil {
			return out, fmt.Errorf("validation failed AND rollback failed: %v / %v", err, restoreErr)
		}
		return out, fmt.Errorf("rejected by validator, live config unchanged (staged edits kept): %w", err)
	}

	// Restart-group changes need a full container restart (re-run entrypoint);
	// everything else applies with a live SIGHUP reload.
	if s.restartMarked() {
		if s.Restart == nil {
			return out, fmt.Errorf("config committed, but no restart mechanism is configured")
		}
		if rErr := s.Restart.RestartTacacs(ctx); rErr != nil {
			return out, fmt.Errorf("config committed, but container restart failed (will apply on next restart): %w", rErr)
		}
	} else if reloadErr := s.Reload.ReloadTacacs(ctx); reloadErr != nil {
		return out, fmt.Errorf("config committed and valid, but reload failed (will apply on next restart): %w", reloadErr)
	}
	_ = os.RemoveAll(s.stagingDir())
	s.pruneBackupsLocked()
	return out, nil
}

func (s *Store) restoreFilesLocked(srcDir string, files []string) error {
	for _, rel := range files {
		b, err := os.ReadFile(filepath.Join(srcDir, filepath.FromSlash(rel)))
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return err
		}
		if err := writeFile0640(s.path(rel), b); err != nil {
			return err
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Backup retention
// ---------------------------------------------------------------------------

type agentSettings struct {
	BackupRetain int `json:"backupRetain"`
}

// Retention returns how many backups to keep (excluding the live config).
func (s *Store) Retention() int {
	b, err := os.ReadFile(s.settingsPath())
	if err == nil {
		var cfg agentSettings
		if json.Unmarshal(b, &cfg) == nil && cfg.BackupRetain > 0 {
			return cfg.BackupRetain
		}
	}
	if s.DefaultRetain > 0 {
		return s.DefaultRetain
	}
	return DefaultRetention
}

// SetRetention persists the retention count and prunes immediately.
func (s *Store) SetRetention(n int) error {
	if n < 1 || n > 100 {
		return fmt.Errorf("retention must be between 1 and 100")
	}
	b, _ := json.Marshal(agentSettings{BackupRetain: n})
	if err := writeFile0640(s.settingsPath(), b); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneBackupsLocked()
	return nil
}

// pruneBackupsLocked deletes the oldest backups beyond the retention count.
// Caller must hold s.mu.
func (s *Store) pruneBackupsLocked() {
	entries, err := os.ReadDir(s.backupsDir())
	if err != nil {
		return
	}
	var ids []string
	for _, e := range entries {
		if e.IsDir() {
			ids = append(ids, e.Name())
		}
	}
	keep := s.Retention()
	if len(ids) <= keep {
		return
	}
	// IDs are timestamps (sortable); ReadDir returns sorted order.
	for _, id := range ids[:len(ids)-keep] {
		_ = os.RemoveAll(filepath.Join(s.backupsDir(), id))
	}
}
