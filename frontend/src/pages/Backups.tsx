import { History, ShieldCheck, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useApi, LoadState } from '../lib/useApi';
import { useAuth } from '../components/AuthProvider';
import { useConfigMode } from '../components/ConfigModeProvider';
import BackupDiffModal from '../components/BackupDiffModal';

// System Management > Backups: global restore points, retention, and the
// protected golden baseline. Per-file restore lives on the Configuration
// page next to the file it affects.
export default function Backups() {
  const { editMode } = useConfigMode();
  const { isAdmin } = useAuth();
  const backups = useApi(api.getBackups);
  const staging = useApi(api.getStaging);
  const golden = useApi(api.getGolden);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionInfo, setActionInfo] = useState<string | null>(null);
  const [workingOn, setWorkingOn] = useState<string | null>(null);
  const [retentionInput, setRetentionInput] = useState('');
  const [diffBackup, setDiffBackup] = useState<{ id: string; timestamp: string } | null>(null);

  const refreshAll = () => Promise.all([backups.reload(), staging.reload(), golden.reload()]);

  const run = async (label: string, fn: () => Promise<unknown>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setActionError(null);
    setActionInfo(null);
    setWorkingOn(label);
    try {
      await fn();
      setActionInfo(`${label} - done.`);
      await refreshAll();
      window.dispatchEvent(new Event('soteria:entities-changed'));
    } catch (e) {
      const msg = e instanceof ApiError && e.validatorOutput ? `${e.message}\n${e.validatorOutput}` : e instanceof Error ? e.message : String(e);
      setActionError(msg);
    } finally {
      setWorkingOn(null);
    }
  };

  const latest = (backups.data ?? [])[0];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold heading">Backups</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--s-muted)' }}>
            Global restore points - every commit and rollback snapshots all config files first
          </p>
        </div>
        {latest && (
          <button
            onClick={() => run('Rollback last commit', () => api.restoreBackup(latest.id),
              `Roll back ALL sections to the state before the last commit (${latest.timestamp})?\n\nThe current config is backed up first, then the result is validated and applied with a live reload.`)}
            disabled={workingOn !== null || editMode}
            title={editMode ? 'Commit or discard the edit session first' : undefined}
            className="btn-danger flex items-center gap-2"
          >
            <RotateCcw className="w-4 h-4" /> Rollback Last Commit
          </button>
        )}
      </div>

      {actionError && (
        <div className="glass-card p-4 border-l-2 border-red-500">
          <pre className="text-sm text-red-400 whitespace-pre-wrap">{actionError}</pre>
        </div>
      )}
      {actionInfo && (
        <div className="glass-card p-4 border-l-2 border-emerald-500">
          <p className="text-sm text-emerald-400">{actionInfo}</p>
        </div>
      )}

      {editMode && (
        <div className="glass-card p-4 border-l-2 border-amber-500">
          <p className="text-sm text-amber-400">
            An Edit Config session is open - restores are disabled until you Commit or Discard it (or use the banner's Rollback…, which discards first).
          </p>
        </div>
      )}

      {/* Golden config */}
      <div className="glass-card overflow-hidden">
        <div className="px-4 py-3 flex items-center justify-between" style={{ backgroundColor: 'var(--s-bg)', borderBottom: '1px solid var(--s-border)' }}>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span className="text-sm font-semibold heading">Golden Config</span>
            <span className="text-xs" style={{ color: 'var(--s-muted)' }}>
              {golden.data?.exists
                ? `baseline saved ${golden.data.savedAt?.replace('T', ' ').replace('Z', '')} (${golden.data.files} files, ${golden.data.size})`
                : 'no baseline saved yet'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {isAdmin && (
              <button
                onClick={() => run('Save golden config', api.saveGolden,
                  golden.data?.exists
                    ? 'Overwrite the golden config with the CURRENT live config? Only administrators can do this.'
                    : 'Save the current live config as the golden baseline?')}
                disabled={workingOn !== null}
                className="btn-secondary text-xs py-1.5 px-3"
              >
                {golden.data?.exists ? 'Overwrite Golden' : 'Save Current as Golden'}
              </button>
            )}
            {golden.data?.exists && (
              <button
                onClick={() => run('Restore golden config', api.restoreGolden,
                  'Restore the golden baseline config? Current state is backed up first, then the golden config is validated and applied with a live reload.')}
                disabled={workingOn !== null || editMode}
                className="btn-primary text-xs py-1.5 px-3"
              >
                Restore Golden
              </button>
            )}
          </div>
        </div>
        <div className="px-4 py-3 text-xs" style={{ color: 'var(--s-muted)' }}>
          The golden config is a protected baseline. It is stored separately from the backups below, never pruned,
          and can only be overwritten by an administrator{isAdmin ? '' : ' - your account is not an administrator'}.
        </div>
      </div>

      {/* Backup versions */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold heading flex items-center gap-2">
            <History className="w-4 h-4" /> Restore Points
          </h3>
          <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--s-muted)' }}>
            <span>Keep</span>
            <input
              type="number"
              min={1}
              max={100}
              className="input-field w-16 py-1 text-xs text-center"
              placeholder={String(staging.data?.retention ?? 5)}
              value={retentionInput}
              onChange={e => setRetentionInput(e.target.value)}
              onBlur={() => {
                const n = parseInt(retentionInput, 10);
                if (!Number.isNaN(n) && n !== staging.data?.retention) {
                  void run(`Set retention to ${n}`, () => api.setRetention(n));
                }
                setRetentionInput('');
              }}
            />
            <span>versions (excluding the live config)</span>
          </div>
        </div>
        <LoadState loading={backups.loading} error={backups.error} onRetry={backups.reload}>
          <div className="glass-card overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead>
                <tr style={{ backgroundColor: 'var(--s-bg)', opacity: 0.7 }}>
                  <th className="table-header">Version</th>
                  <th className="table-header">Timestamp (UTC)</th>
                  <th className="table-header">Size</th>
                  <th className="table-header">Files</th>
                  <th className="table-header w-28">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(backups.data ?? []).map((backup, i) => (
                  <tr key={backup.id} className="table-row">
                    <td className="table-cell font-mono text-xs heading">
                      {backup.id}{i === 0 && <span className="badge-success ml-2">latest</span>}
                    </td>
                    <td className="table-cell font-mono text-xs" style={{ color: 'var(--s-muted)' }}>{backup.timestamp}</td>
                    <td className="table-cell text-sm" style={{ color: 'var(--s-muted)' }}>{backup.size}</td>
                    <td className="table-cell text-sm" style={{ color: 'var(--s-muted)' }}>{backup.files}</td>
                    <td className="table-cell">
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => setDiffBackup({ id: backup.id, timestamp: backup.timestamp })}
                          className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                          title="Compare the current config with this version"
                        >
                          Diff
                        </button>
                        <button
                          onClick={() => void run(`Restore ${backup.id}`,
                            () => api.restoreBackup(backup.id),
                            `Restore ALL sections from backup ${backup.id} (${backup.timestamp})?\n\nThe current config is backed up first, then the result is validated and applied with a live reload.`)}
                          disabled={workingOn !== null || editMode}
                          className="text-xs text-amber-400 hover:text-amber-300 transition-colors disabled:opacity-40"
                        >
                          {workingOn === `Restore ${backup.id}` ? 'Restoring…' : 'Restore All'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(backups.data ?? []).length === 0 && (
              <div className="py-8 text-center text-sm" style={{ color: 'var(--s-muted)' }}>
                No backups yet - a snapshot is taken automatically before every commit and rollback.
              </div>
            )}
          </div>
        </LoadState>
        <p className="text-xs mt-2" style={{ color: 'var(--s-muted)', opacity: 0.8 }}>
          Restoring here is always global (every config file). To restore a single file, use the backup list under
          that file on the Configuration page.
        </p>
      </div>

      {diffBackup && (
        <BackupDiffModal
          open={!!diffBackup}
          onClose={() => setDiffBackup(null)}
          backupId={diffBackup.id}
          timestamp={diffBackup.timestamp}
          restoreLabel="Restore All"
          restoring={workingOn !== null}
          onRestore={editMode ? undefined : () => {
            const b = diffBackup;
            setDiffBackup(null);
            void run(`Restore ${b.id}`, () => api.restoreBackup(b.id),
              `Restore ALL sections from backup ${b.id} (${b.timestamp})?`);
          }}
        />
      )}
    </div>
  );
}
