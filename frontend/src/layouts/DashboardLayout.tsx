import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import { useIsDesktop } from '../lib/useMediaQuery';
import TopBar from '../components/TopBar';
import RollbackModal from '../components/RollbackModal';
import DiffModal from '../components/DiffModal';
import ErrorBoundary from '../components/ErrorBoundary';
import Footer from '../components/Footer';
import { useConfigMode } from '../components/ConfigModeProvider';
import { AlertTriangle, Check, RotateCcw, GitCompare, X } from 'lucide-react';
import { FILE_SECTIONS } from '../lib/api';

export default function DashboardLayout() {
  // Desktop: expanded rail vs icon rail. Mobile: off-canvas drawer open/closed.
  const [desktopExpanded, setDesktopExpanded] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const isDesktop = useIsDesktop();
  const location = useLocation();
  // Close the mobile drawer whenever the route changes.
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);
  const sidebarOpen = isDesktop ? desktopExpanded : true; // labels always shown in the mobile drawer
  const { editMode, changedFiles, restartRequired, busy, lastError, lastResult, commit, discard, clearMessages } = useConfigMode();
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);

  const changedSections = [...new Set(changedFiles.map(f => FILE_SECTIONS[f] ?? f))];

  const onCommit = async () => {
    if (changedFiles.length === 0) {
      await commit(); // closes the empty session
      return;
    }
    const restartNote = restartRequired
      ? '\n\n⚠ This includes settings that require RESTARTING the tac_plus container — TACACS auth will be briefly interrupted (~10s).'
      : '';
    if (!window.confirm(`Commit ${changedFiles.length} changed section file(s) to the TACACS+ server?\n\n${changedSections.join('\n')}\n\nThe config is validated first; a backup is taken automatically.${restartNote}`)) return;
    await commit();
  };

  const onDiscard = async () => {
    if (changedFiles.length > 0 &&
        !window.confirm(`Discard ALL staged changes?\n\n${changedSections.join('\n')}\n\nThe live config stays as it is.`)) return;
    await discard();
  };


  return (
    <div className="flex h-screen overflow-hidden" style={{ backgroundColor: 'var(--s-bg)' }}>
      <Sidebar
        open={sidebarOpen}
        onToggle={() => setDesktopExpanded(v => !v)}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <TopBar onMenuToggle={() => setMobileOpen(v => !v)} />
        {editMode && (
          <div className="px-4 lg:px-6 py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 shrink-0" style={{ backgroundColor: 'rgba(251, 191, 36, 0.08)', borderBottom: '1px solid rgba(251, 191, 36, 0.2)' }}>
            <div className="flex items-center gap-3 min-w-0">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
              <div className="min-w-0">
                <span className="text-sm font-semibold text-amber-400">Edit Mode Active</span>
                <span className="text-xs ml-2" style={{ color: 'var(--s-muted)' }}>
                  {changedFiles.length === 0
                    ? 'No changes staged yet - edits on entity pages are staged until you commit.'
                    : `${changedFiles.length} section file(s) pending: ${changedSections.join(', ')}`}
                </span>
              </div>
            </div>
            <div className="flex items-center flex-wrap gap-2 shrink-0">
              <button onClick={() => setDiffOpen(true)} className="btn-ghost text-xs flex items-center gap-1.5 py-1.5 px-3">
                <GitCompare className="w-3.5 h-3.5" /> Diff
              </button>
              <button onClick={onDiscard} disabled={busy} className="btn-ghost text-xs flex items-center gap-1.5 py-1.5 px-3">
                <X className="w-3.5 h-3.5" /> Discard
              </button>
              <button onClick={() => setRollbackOpen(true)} disabled={busy} title="Restore a previous version - pick the backup and the scope" className="btn-danger text-xs flex items-center gap-1.5 py-1.5 px-3">
                <RotateCcw className="w-3.5 h-3.5" /> Rollback…
              </button>
              <button onClick={onCommit} disabled={busy} className="btn-primary text-xs flex items-center gap-1.5 py-1.5 px-3">
                <Check className="w-3.5 h-3.5" /> {busy ? 'Working…' : `Commit${changedFiles.length > 0 ? ` (${changedFiles.length})` : ''}`}
              </button>
            </div>
          </div>
        )}
        {(lastError || lastResult) && (
          <div className="px-4 lg:px-6 py-2 flex items-start justify-between gap-4 shrink-0" style={{
            backgroundColor: lastError ? 'rgba(239, 68, 68, 0.08)' : 'rgba(52, 211, 153, 0.08)',
            borderBottom: `1px solid ${lastError ? 'rgba(239, 68, 68, 0.2)' : 'rgba(52, 211, 153, 0.2)'}`,
          }}>
            <pre className={`text-xs whitespace-pre-wrap ${lastError ? 'text-red-400' : 'text-emerald-400'}`}>{lastError ?? lastResult}</pre>
            <button onClick={clearMessages} className="p-0.5 shrink-0" style={{ color: 'var(--s-muted)' }}><X className="w-3.5 h-3.5" /></button>
          </div>
        )}
        <main className="flex-1 overflow-y-auto p-4 lg:p-6 flex flex-col">
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
          <Footer />
        </main>
        <RollbackModal open={rollbackOpen} onClose={() => setRollbackOpen(false)} />
        <DiffModal open={diffOpen} onClose={() => setDiffOpen(false)} />
      </div>
    </div>
  );
}
