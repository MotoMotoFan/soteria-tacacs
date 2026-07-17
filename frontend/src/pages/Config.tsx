import { FileCode, Play, History, GitCompare } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError, FILE_SECTIONS, type FileDiff } from '../lib/api';
import { useApi, LoadState } from '../lib/useApi';
import { useConfigMode } from '../components/ConfigModeProvider';
import DiffView from '../components/DiffView';
import BackupDiffModal from '../components/BackupDiffModal';

const fileDescriptions: Record<string, string> = {
  'tac_plus-ng.cfg': 'Main config - spawnd + includes',
  'conf.d/01-logging.cfg': 'Log destinations and assignments',
  'conf.d/02-dns.cfg': 'DNS resolution settings',
  'conf.d/03-mavis.cfg': 'MAVIS/LDAP authentication backend',
  'conf.d/04-devices.cfg': 'Network device (NAS) definitions',
  'conf.d/05-local-users.cfg': 'Local fallback users',
  'conf.d/06-groups.cfg': 'Group definitions',
  'conf.d/07-profiles.cfg': 'Authorization profiles',
  'conf.d/08-ruleset.cfg': 'Group-to-profile mapping rules',
  'conf.d/09-tls.cfg': 'TLS certificate config',
};

export default function Config() {
  const { editMode, enterEdit, changedFiles } = useConfigMode();
  const files = useApi(api.getConfigFiles);
  const backups = useApi(api.getBackups);
  const stagingDiff = useApi(api.getStagingDiff, [editMode, changedFiles.length]);
  const [selectedFile, setSelectedFile] = useState('conf.d/04-devices.cfg');
  const content = useApi(() => api.getConfigFileRaw(selectedFile), [selectedFile]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionInfo, setActionInfo] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [diffBackup, setDiffBackup] = useState<{ id: string; timestamp: string } | null>(null);

  const restoreFile = async (backupId: string, timestamp: string) => {
    const label = FILE_SECTIONS[selectedFile] ?? selectedFile;
    if (!window.confirm(`Restore ONLY ${label} (${selectedFile}) from the ${timestamp} backup?\n\nAll other files keep their current config. The current state is backed up first, then the result is validated and applied with a live reload.`)) return;
    setActionError(null);
    setActionInfo(null);
    setRestoring(backupId);
    try {
      await api.restoreBackup(backupId, [selectedFile]);
      setActionInfo(`${label} restored from ${timestamp}.`);
      await Promise.all([files.reload(), backups.reload(), content.reload()]);
      window.dispatchEvent(new Event('soteria:entities-changed'));
    } catch (e) {
      const msg = e instanceof ApiError && e.validatorOutput ? `${e.message}\n${e.validatorOutput}` : e instanceof Error ? e.message : String(e);
      setActionError(msg);
    } finally {
      setRestoring(null);
    }
  };

  const diffs = stagingDiff.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold heading">Configuration</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--s-muted)' }}>Live tac_plus-ng config - entity pages stage changes here until commit</p>
        </div>
        {!editMode && (
          <button onClick={enterEdit} className="btn-primary flex items-center gap-2">
            <Play className="w-4 h-4" /> Enter Edit Mode
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

      {/* Pending changes (diff live -> staged), grouped per section */}
      {editMode && (
        <div className="glass-card overflow-hidden">
          <div className="px-4 py-3 flex items-center gap-2" style={{ backgroundColor: 'var(--s-bg)', borderBottom: '1px solid var(--s-border)' }}>
            <GitCompare className="w-4 h-4 text-amber-400" />
            <span className="text-sm font-semibold heading">Pending Changes</span>
            <span className="text-xs" style={{ color: 'var(--s-muted)' }}>
              {diffs.length === 0 ? 'nothing staged yet' : `${diffs.length} section file(s) differ from the live config`}
            </span>
          </div>
          {diffs.length > 0 && (
            <div className="p-4 space-y-4">
              {diffs.map((d: FileDiff) => (
                <div key={d.file}>
                  <p className="text-xs font-semibold mb-1.5 heading">{FILE_SECTIONS[d.file] ?? d.file} <span className="font-mono font-normal" style={{ color: 'var(--s-muted)' }}>({d.file})</span></p>
                  <DiffView diff={d.diff} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <div className="space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wider mb-3 px-1" style={{ color: 'var(--s-muted)' }}>Config Files</h3>
          {(files.data ?? []).map(file => (
            <button
              key={file.name}
              onClick={() => setSelectedFile(file.name)}
              className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all ${selectedFile === file.name ? 'bg-brand-purple/15 border border-brand-purple/30' : ''}`}
              style={{ color: selectedFile === file.name ? 'var(--s-heading)' : 'var(--s-muted)' }}
            >
              <div className="flex items-center gap-2">
                <FileCode className="w-3.5 h-3.5 shrink-0" />
                <span className="font-mono text-xs">{file.name.replace('conf.d/', '')}</span>
                {changedFiles.includes(file.name) && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="staged changes" />}
              </div>
              <p className="text-[10px] mt-0.5 ml-5" style={{ color: 'var(--s-muted)', opacity: 0.7 }}>
                {fileDescriptions[file.name] ?? `${(file.size / 1024).toFixed(1)} KB`}
              </p>
            </button>
          ))}
          {files.loading && <p className="px-3 py-2 text-xs" style={{ color: 'var(--s-muted)' }}>Loading…</p>}
          {files.error && <p className="px-3 py-2 text-xs text-red-400">{files.error}</p>}
        </div>

        <div className="lg:col-span-3 space-y-6">
          <div className="glass-card overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3" style={{ backgroundColor: 'var(--s-bg)', borderBottom: '1px solid var(--s-border)' }}>
              <div className="flex items-center gap-2">
                <FileCode className="w-4 h-4" style={{ color: 'var(--s-muted)' }} />
                <span className="font-mono text-sm heading">{selectedFile}</span>
                {editMode && changedFiles.includes(selectedFile) && <span className="badge-warning">staged version</span>}
              </div>
              {editMode && <span className="badge-warning">Editing</span>}
            </div>
            <div className="p-4">
              <pre className={`config-preview min-h-[300px] max-h-[55vh] overflow-auto whitespace-pre ${editMode ? 'ring-1 ring-brand-purple/20' : ''}`}>
                {content.loading ? '# Loading…' : content.error ? `# Error: ${content.error}` : content.data}
              </pre>
            </div>
          </div>

          {/* Backups for the SELECTED file only - global restore lives on the Backups page */}
          <div>
            <h3 className="text-sm font-semibold heading mb-3 flex items-center gap-2">
              <History className="w-4 h-4" /> Backups - <span className="font-mono text-xs">{selectedFile}</span>
            </h3>
            <LoadState loading={backups.loading} error={backups.error} onRetry={backups.reload}>
              <div className="glass-card overflow-x-auto">
                <table className="w-full min-w-[640px]">
                  <thead>
                    <tr style={{ backgroundColor: 'var(--s-bg)', opacity: 0.7 }}>
                      <th className="table-header">Version</th>
                      <th className="table-header">Timestamp (UTC)</th>
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
                        <td className="table-cell">
                          <div className="flex items-center gap-3">
                            <button
                              onClick={() => setDiffBackup({ id: backup.id, timestamp: backup.timestamp })}
                              className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                              title={`Compare the current ${selectedFile} with this version`}
                            >
                              Diff
                            </button>
                            <button
                              onClick={() => restoreFile(backup.id, backup.timestamp)}
                              disabled={restoring !== null || editMode}
                              title={editMode ? 'Commit or discard the edit session first' : `Restore only ${selectedFile} from this version`}
                              className="text-xs text-amber-400 hover:text-amber-300 transition-colors disabled:opacity-40"
                            >
                              {restoring === backup.id ? 'Restoring…' : 'Restore This File'}
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
              Restoring here affects ONLY <span className="font-mono">{selectedFile}</span>. For global restore points,
              retention, and the golden config, see System Management → Backups.
            </p>
          </div>
        </div>
      </div>

      {diffBackup && (
        <BackupDiffModal
          open={!!diffBackup}
          onClose={() => setDiffBackup(null)}
          backupId={diffBackup.id}
          timestamp={diffBackup.timestamp}
          file={selectedFile}
          restoreLabel="Restore This File"
          restoring={restoring !== null}
          onRestore={editMode ? undefined : () => {
            const b = diffBackup;
            setDiffBackup(null);
            void restoreFile(b.id, b.timestamp);
          }}
        />
      )}
    </div>
  );
}
