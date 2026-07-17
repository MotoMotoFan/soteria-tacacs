import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from 'react';
import { api, ApiError } from '../lib/api';

interface ConfigModeContextType {
  /** True while an agent-side edit (staging) session is open. */
  editMode: boolean;
  /** Config files with staged changes not yet committed. */
  changedFiles: string[];
  /** True when committing will restart the tac_plus container. */
  restartRequired: boolean;
  busy: boolean;
  /** Error/result from the last enter/commit/discard action. */
  lastError: string | null;
  lastResult: string | null;
  enterEdit: () => Promise<void>;
  commit: () => Promise<boolean>;
  discard: () => Promise<void>;
  /**
   * Rollback to a chosen backup: discards any staged edits first, then
   * restores. files empty/omitted = all sections (global); otherwise only
   * the given section files.
   */
  rollbackTo: (backupId: string, files?: string[]) => Promise<boolean>;
  refresh: () => Promise<void>;
  clearMessages: () => void;
}

const ConfigModeContext = createContext<ConfigModeContextType>({
  editMode: false,
  changedFiles: [],
  restartRequired: false,
  busy: false,
  lastError: null,
  lastResult: null,
  enterEdit: async () => {},
  commit: async () => false,
  discard: async () => {},
  rollbackTo: async () => false,
  refresh: async () => {},
  clearMessages: () => {},
});

export function useConfigMode() {
  return useContext(ConfigModeContext);
}

export function ConfigModeProvider({ children }: { children: ReactNode }) {
  const [editMode, setEditMode] = useState(false);
  const [changedFiles, setChangedFiles] = useState<string[]>([]);
  const [restartRequired, setRestartRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const info = await api.getStaging();
      setEditMode(info.active);
      setChangedFiles(info.changedFiles);
      setRestartRequired(info.restartRequired ?? false);
    } catch {
      // Agent unreachable - leave state as-is; pages surface their own errors.
    }
  }, []);

  // Staging state lives on the agent, so it survives reloads and stays
  // consistent across tabs. Entity saves dispatch this event.
  useEffect(() => {
    void refresh();
    const handler = () => void refresh();
    window.addEventListener('soteria:staging-changed', handler);
    return () => window.removeEventListener('soteria:staging-changed', handler);
  }, [refresh]);

  const enterEdit = useCallback(async () => {
    setLastError(null);
    setLastResult(null);
    setBusy(true);
    try {
      await api.beginStaging();
      await refresh();
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const commit = useCallback(async () => {
    setLastError(null);
    setLastResult(null);
    setBusy(true);
    try {
      const res = await api.commitStaging();
      setLastResult(
        res.validatorOutput && res.validatorOutput !== ''
          ? `Committed and reloaded. ${res.validatorOutput}`
          : res.status === 'committed' ? 'All changes committed and applied to the TACACS+ server.' : res.validatorOutput ?? res.status,
      );
      await refresh();
      window.dispatchEvent(new Event('soteria:entities-changed'));
      return true;
    } catch (e) {
      const msg = e instanceof ApiError && e.validatorOutput
        ? `${e.message}\n${e.validatorOutput}`
        : e instanceof Error ? e.message : String(e);
      setLastError(msg);
      await refresh();
      return false;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const discard = useCallback(async () => {
    setLastError(null);
    setLastResult(null);
    setBusy(true);
    try {
      await api.discardStaging();
      setLastResult('Staged changes discarded - live config untouched.');
      await refresh();
      // Entity pages cache staged data; force them to refetch live state.
      window.dispatchEvent(new Event('soteria:entities-changed'));
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const rollbackTo = useCallback(async (backupId: string, files?: string[]) => {
    setLastError(null);
    setLastResult(null);
    setBusy(true);
    try {
      await api.discardStaging(); // restore requires no open edit session
      const res = await api.restoreBackup(backupId, files);
      const scope = files?.length ? files.join(', ') : 'all sections';
      setLastResult(`Rolled back ${scope} to backup ${backupId}.${res.validatorOutput ? ` ${res.validatorOutput}` : ''}`);
      await refresh();
      window.dispatchEvent(new Event('soteria:entities-changed'));
      return true;
    } catch (e) {
      const msg = e instanceof ApiError && e.validatorOutput
        ? `${e.message}\n${e.validatorOutput}`
        : e instanceof Error ? e.message : String(e);
      setLastError(msg);
      await refresh();
      return false;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const clearMessages = useCallback(() => {
    setLastError(null);
    setLastResult(null);
  }, []);

  return (
    <ConfigModeContext.Provider value={{ editMode, changedFiles, restartRequired, busy, lastError, lastResult, enterEdit, commit, discard, rollbackTo, refresh, clearMessages }}>
      {children}
    </ConfigModeContext.Provider>
  );
}
