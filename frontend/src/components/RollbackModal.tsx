import { useState } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import Modal from './Modal';
import DiffView from './DiffView';
import { api, FILE_SECTIONS, type FileDiff } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useConfigMode } from './ConfigModeProvider';

/**
 * Rollback picker with mandatory preview: choose the backup version and
 * the scope, review exactly what would change (live → backup), then decide
 * to apply or cancel. Staged (uncommitted) edits are discarded on apply.
 */
export default function RollbackModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { changedFiles, busy, rollbackTo } = useConfigMode();
  const backups = useApi(api.getBackups, [open]);
  const [backupId, setBackupId] = useState('');
  const [scope, setScope] = useState(''); // '' = all sections

  const list = backups.data ?? [];
  const effectiveId = backupId || list[0]?.id || '';

  // Preview: what applying this rollback would change right now.
  const preview = useApi(
    () => (open && effectiveId ? api.getBackupDiff(effectiveId, scope || undefined) : Promise.resolve([] as FileDiff[])),
    [open, effectiveId, scope],
  );
  const diffs = preview.data ?? [];

  const apply = async () => {
    if (!effectiveId || diffs.length === 0) return;
    const ok = await rollbackTo(effectiveId, scope ? [scope] : undefined);
    if (ok) {
      setBackupId('');
      setScope('');
      onClose();
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Rollback Configuration" maxWidth="max-w-4xl">
      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Restore from version</label>
            {backups.loading ? (
              <p className="text-sm" style={{ color: 'var(--s-muted)' }}>Loading backups…</p>
            ) : list.length === 0 ? (
              <p className="text-sm text-red-400">No backups available yet - a backup is created on every commit.</p>
            ) : (
              <select className="select-field" value={effectiveId} onChange={e => setBackupId(e.target.value)}>
                {list.map((b, i) => (
                  <option key={b.id} value={b.id}>
                    {b.timestamp}{i === 0 ? ' - latest (state before last commit)' : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Scope</label>
            <select className="select-field" value={scope} onChange={e => setScope(e.target.value)}>
              <option value="">All sections (global rollback)</option>
              {Object.entries(FILE_SECTIONS).map(([file, label]) => (
                <option key={file} value={file}>{label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Preview - review before deciding */}
        <div>
          <p className="text-xs font-semibold mb-2 heading">
            Preview{' '}
            <span className="font-normal" style={{ color: 'var(--s-muted)' }}>
              - <span style={{ color: '#34d399' }}>green lines are added</span>,{' '}
              <span style={{ color: '#f87171' }}>red lines are removed</span> if you apply this rollback
            </span>
          </p>
          <div className="space-y-4 max-h-[45vh] overflow-y-auto pr-1">
            {preview.loading && <p className="text-sm py-6 text-center" style={{ color: 'var(--s-muted)' }}>Computing diff…</p>}
            {preview.error && <p className="text-sm py-6 text-center text-red-400">{preview.error}</p>}
            {!preview.loading && !preview.error && diffs.length === 0 && effectiveId && (
              <p className="text-sm py-6 text-center" style={{ color: 'var(--s-muted)' }}>
                No differences - the selected scope is already identical to this version. Nothing to apply.
              </p>
            )}
            {diffs.map(d => (
              <div key={d.file}>
                <p className="text-xs font-semibold mb-1.5 heading">
                  {FILE_SECTIONS[d.file] ?? d.file}{' '}
                  <span className="font-mono font-normal" style={{ color: 'var(--s-muted)' }}>({d.file})</span>
                </p>
                <DiffView diff={d.diff} />
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg p-3 space-y-1.5 text-xs" style={{ backgroundColor: 'rgba(251, 191, 36, 0.08)', border: '1px solid rgba(251, 191, 36, 0.2)' }}>
          {changedFiles.length > 0 && (
            <p className="flex items-center gap-1.5 text-amber-400 font-medium">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              Your {changedFiles.length} staged (uncommitted) change(s) will be discarded when you apply.
            </p>
          )}
          <p style={{ color: 'var(--s-muted)' }}>
            Applying backs up the current config first, then the restored result is validated and reloaded live.
          </p>
        </div>

        <div className="flex justify-end gap-3 pt-1">
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button
            type="button"
            onClick={apply}
            disabled={busy || preview.loading || !effectiveId || diffs.length === 0}
            title={diffs.length === 0 ? 'Nothing would change' : undefined}
            className="btn-danger flex items-center gap-2"
          >
            <RotateCcw className="w-4 h-4" /> {busy ? 'Rolling back…' : 'Apply Rollback'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
