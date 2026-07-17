import Modal from './Modal';
import DiffView from './DiffView';
import { api, FILE_SECTIONS, type FileDiff } from '../lib/api';
import { useApi } from '../lib/useApi';

/**
 * Preview of what restoring a backup would change (live → backup: green
 * lines get added, red lines get removed if applied). Optional restore
 * action so the user can decide directly from the preview.
 */
export default function BackupDiffModal({ open, onClose, backupId, timestamp, file, onRestore, restoreLabel, restoring }: {
  open: boolean;
  onClose: () => void;
  backupId: string;
  timestamp: string;
  /** Narrow the diff to one config file (Configuration page); omit for all files. */
  file?: string;
  onRestore?: () => void;
  restoreLabel?: string;
  restoring?: boolean;
}) {
  const diffs = useApi(
    () => (open && backupId ? api.getBackupDiff(backupId, file) : Promise.resolve([] as FileDiff[])),
    [open, backupId, file],
  );
  const list = diffs.data ?? [];

  return (
    <Modal open={open} onClose={onClose} title={`Diff - current config vs backup ${timestamp}`} maxWidth="max-w-4xl">
      <div className="space-y-4">
        <p className="text-xs" style={{ color: 'var(--s-muted)' }}>
          Showing what restoring {file ? <span className="font-mono">{file}</span> : 'this backup'} would change:{' '}
          <span style={{ color: '#34d399' }}>green lines are added</span> and{' '}
          <span style={{ color: '#f87171' }}>red lines are removed</span> if you apply it.
        </p>

        <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
          {diffs.loading && <p className="text-sm py-6 text-center" style={{ color: 'var(--s-muted)' }}>Loading…</p>}
          {diffs.error && <p className="text-sm py-6 text-center text-red-400">{diffs.error}</p>}
          {!diffs.loading && !diffs.error && list.length === 0 && (
            <p className="text-sm py-6 text-center" style={{ color: 'var(--s-muted)' }}>
              No differences - {file ? 'this file is' : 'all files are'} identical to the selected backup.
            </p>
          )}
          {list.map(d => (
            <div key={d.file}>
              <p className="text-xs font-semibold mb-1.5 heading">
                {FILE_SECTIONS[d.file] ?? d.file}{' '}
                <span className="font-mono font-normal" style={{ color: 'var(--s-muted)' }}>({d.file})</span>
              </p>
              <DiffView diff={d.diff} />
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-3 pt-1">
          <button onClick={onClose} className="btn-ghost">Close</button>
          {onRestore && (
            <button
              onClick={onRestore}
              disabled={restoring || diffs.loading || list.length === 0}
              title={list.length === 0 ? 'Nothing would change' : undefined}
              className="btn-primary"
            >
              {restoring ? 'Restoring…' : restoreLabel ?? 'Restore'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
