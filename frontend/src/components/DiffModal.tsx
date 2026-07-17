import { useState } from 'react';
import { GitCompare } from 'lucide-react';
import Modal from './Modal';
import DiffView from './DiffView';
import { api, FILE_SECTIONS, type FileDiff } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useConfigMode } from './ConfigModeProvider';

/**
 * Overlay showing the pending (staged vs live) changes without leaving the
 * current page. Scope selector switches between all diffs and one section.
 */
export default function DiffModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { changedFiles } = useConfigMode();
  const diffs = useApi(
    () => (open ? api.getStagingDiff() : Promise.resolve([] as FileDiff[])),
    [open, changedFiles.length],
  );
  const [scope, setScope] = useState(''); // '' = all sections

  const all = diffs.data ?? [];
  const shown = scope ? all.filter(d => d.file === scope) : all;

  return (
    <Modal open={open} onClose={onClose} title="Pending Changes - staged vs live config" maxWidth="max-w-4xl">
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--s-muted)' }}>
            <GitCompare className="w-4 h-4 text-amber-400 shrink-0" />
            {all.length === 0
              ? 'Nothing staged yet - edits on entity pages appear here before you commit.'
              : `${all.length} section file(s) differ from the live config.`}
          </div>
          {all.length > 0 && (
            <select className="select-field text-xs py-1.5 w-full sm:w-64 shrink-0" value={scope} onChange={e => setScope(e.target.value)}>
              <option value="">All changed sections</option>
              {all.map(d => (
                <option key={d.file} value={d.file}>{FILE_SECTIONS[d.file] ?? d.file}</option>
              ))}
            </select>
          )}
        </div>

        <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
          {diffs.loading && <p className="text-sm py-6 text-center" style={{ color: 'var(--s-muted)' }}>Loading…</p>}
          {diffs.error && <p className="text-sm py-6 text-center text-red-400">{diffs.error}</p>}
          {shown.map(d => (
            <div key={d.file}>
              <p className="text-xs font-semibold mb-1.5 heading">
                {FILE_SECTIONS[d.file] ?? d.file}{' '}
                <span className="font-mono font-normal" style={{ color: 'var(--s-muted)' }}>({d.file})</span>
              </p>
              <DiffView diff={d.diff} />
            </div>
          ))}
          {!diffs.loading && !diffs.error && shown.length === 0 && all.length > 0 && (
            <p className="text-sm py-6 text-center" style={{ color: 'var(--s-muted)' }}>
              The selected section has no pending changes.
            </p>
          )}
        </div>

        <div className="flex justify-end pt-1">
          <button onClick={onClose} className="btn-ghost">Close</button>
        </div>
      </div>
    </Modal>
  );
}
