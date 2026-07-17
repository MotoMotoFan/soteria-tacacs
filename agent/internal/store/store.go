// Package store owns the tac_plus-ng config directory shared with the
// server container. Every write goes through the commit pipeline:
//
//	backup current config -> write candidate -> validate (exec in server
//	container) -> SIGHUP reload; on validation failure the original file
//	is restored and the live config is untouched.
package store

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Pathfinder-Insights/soteria-agent/internal/model"
)

// ManagedFiles are the config files the agent may read/serve raw.
var ManagedFiles = []string{
	"tac_plus-ng.cfg",
	"conf.d/01-logging.cfg",
	"conf.d/02-dns.cfg",
	"conf.d/03-mavis.cfg",
	"conf.d/04-devices.cfg",
	"conf.d/05-local-users.cfg",
	"conf.d/06-groups.cfg",
	"conf.d/07-profiles.cfg",
	"conf.d/08-ruleset.cfg",
	"conf.d/09-tls.cfg",
	"agent-overrides.env",
}

// Entity config files (the ones the agent writes).
const (
	MainFile     = "tac_plus-ng.cfg"
	LoggingFile  = "conf.d/01-logging.cfg"
	DNSFile      = "conf.d/02-dns.cfg"
	MavisFile    = "conf.d/03-mavis.cfg"
	DevicesFile  = "conf.d/04-devices.cfg"
	UsersFile    = "conf.d/05-local-users.cfg"
	GroupsFile   = "conf.d/06-groups.cfg"
	ProfilesFile = "conf.d/07-profiles.cfg"
	RulesetFile  = "conf.d/08-ruleset.cfg"
	TLSFile      = "conf.d/09-tls.cfg"
	// OverridesFile holds env-only settings (TZ, log rotation) the entrypoint
	// sources at start; applied via a container restart, not SIGHUP.
	OverridesFile = "agent-overrides.env"
)

// Validator/Reloader are satisfied by dockerctl.Client.
type Validator interface {
	ValidateConfig(ctx context.Context) (string, error)
}
type Reloader interface {
	ReloadTacacs(ctx context.Context) error
}
type Restarter interface {
	RestartTacacs(ctx context.Context) error
}

type Store struct {
	Dir      string // /etc/tac_plus-ng
	Validate Validator
	Reload   Reloader
	Restart  Restarter
	// DevMode skips validation and reload (local development without the
	// server container). Never enable in the lab/production deployment.
	DevMode bool
	// DefaultRetain is the backup retention used when no persisted
	// setting exists (from AGENT_BACKUP_RETAIN, default 5).
	DefaultRetain int

	mu sync.Mutex
}

func (s *Store) path(rel string) string { return filepath.Join(s.Dir, filepath.FromSlash(rel)) }

func (s *Store) backupsDir() string { return filepath.Join(s.Dir, "backups") }

// ReadFile returns the raw content of a managed config file.
func (s *Store) ReadFile(rel string) (string, error) {
	if !isManaged(rel) {
		return "", fmt.Errorf("not a managed config file: %s", rel)
	}
	b, err := os.ReadFile(s.path(rel))
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func isManaged(rel string) bool {
	for _, f := range ManagedFiles {
		if f == rel {
			return true
		}
	}
	return false
}

// ListFiles returns metadata for all managed config files.
func (s *Store) ListFiles() []model.ConfigFile {
	files := []model.ConfigFile{}
	for _, rel := range ManagedFiles {
		fi, err := os.Stat(s.path(rel))
		if err != nil {
			continue
		}
		files = append(files, model.ConfigFile{
			Name:     rel,
			Size:     fi.Size(),
			Modified: fi.ModTime().UTC().Format(time.RFC3339),
		})
	}
	return files
}

// snapshotLocked copies all managed files into backups/<timestamp>/.
// Caller must hold s.mu.
func (s *Store) snapshotLocked() (string, error) {
	id := time.Now().UTC().Format("20060102-150405")
	dir := filepath.Join(s.backupsDir(), id)
	if err := os.MkdirAll(filepath.Join(dir, "conf.d"), 0o750); err != nil {
		return "", err
	}
	for _, rel := range ManagedFiles {
		b, err := os.ReadFile(s.path(rel))
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return "", err
		}
		if err := writeFile0640(filepath.Join(dir, filepath.FromSlash(rel)), b); err != nil {
			return "", err
		}
	}
	return id, nil
}

// Backups lists snapshots, newest first.
func (s *Store) Backups() []model.ConfigBackup {
	entries, err := os.ReadDir(s.backupsDir())
	if err != nil {
		return []model.ConfigBackup{}
	}
	backups := []model.ConfigBackup{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		id := e.Name()
		ts, err := time.Parse("20060102-150405", id)
		if err != nil {
			continue
		}
		var size int64
		var count int
		_ = filepath.Walk(filepath.Join(s.backupsDir(), id), func(_ string, fi os.FileInfo, err error) error {
			if err == nil && !fi.IsDir() {
				size += fi.Size()
				count++
			}
			return nil
		})
		backups = append(backups, model.ConfigBackup{
			ID:        id,
			Timestamp: ts.Format("2006-01-02 15:04:05"),
			Size:      humanSize(size),
			Files:     count,
		})
	}
	sort.Slice(backups, func(i, j int) bool { return backups[i].ID > backups[j].ID })
	return backups
}

// Restore copies a snapshot back into the live config dir (taking a fresh
// snapshot of the current state first), validates, and reloads. If files
// is non-empty only those files are restored (per-section rollback);
// otherwise the whole snapshot is applied (global rollback). If the
// restored config fails validation the pre-restore state is put back.
func (s *Store) Restore(ctx context.Context, backupID string, files []string) (string, error) {
	if strings.ContainsAny(backupID, `/\.`) {
		return "", fmt.Errorf("invalid backup id")
	}
	if s.StagingActive() {
		return "", fmt.Errorf("an edit session is open — commit or discard it before restoring a backup")
	}
	for _, f := range files {
		if !isManaged(f) {
			return "", fmt.Errorf("not a managed config file: %s", f)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	srcDir := filepath.Join(s.backupsDir(), backupID)
	if fi, err := os.Stat(srcDir); err != nil || !fi.IsDir() {
		return "", fmt.Errorf("backup %s not found", backupID)
	}

	preRestoreID, err := s.snapshotLocked()
	if err != nil {
		return "", fmt.Errorf("snapshotting current config before restore: %w", err)
	}

	if len(files) > 0 {
		err = s.restoreFilesLocked(srcDir, files)
	} else {
		err = s.copySnapshotLocked(srcDir)
	}
	if err != nil {
		return "", fmt.Errorf("restoring %s: %w", backupID, err)
	}

	if s.DevMode {
		s.pruneBackupsLocked()
		return "dev mode: validation and reload skipped", nil
	}

	out, err := s.Validate.ValidateConfig(ctx)
	if err != nil {
		if rbErr := s.copySnapshotLocked(filepath.Join(s.backupsDir(), preRestoreID)); rbErr != nil {
			return out, fmt.Errorf("restored config invalid AND rollback failed: %v / %v", err, rbErr)
		}
		return out, fmt.Errorf("backup %s failed validation, previous config kept: %w", backupID, err)
	}
	if err := s.Reload.ReloadTacacs(ctx); err != nil {
		return out, fmt.Errorf("restored and valid, but reload failed: %w", err)
	}
	s.pruneBackupsLocked()
	return out, nil
}

func (s *Store) copySnapshotLocked(srcDir string) error {
	return s.restoreFilesLocked(srcDir, ManagedFiles)
}

func writeFile0640(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o640); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func humanSize(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KB", float64(n)/(1<<10))
	default:
		return fmt.Sprintf("%d B", n)
	}
}
