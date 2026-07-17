import { createContext, useContext, useState, ReactNode } from 'react';

type ConfigState = 'idle' | 'editing';

interface ConfigContextType {
  state: ConfigState;
  enterEditMode: () => void;
  commit: () => void;
  rollback: () => void;
  checkpoint: string | null;
}

const ConfigContext = createContext<ConfigContextType>({
  state: 'idle',
  enterEditMode: () => {},
  commit: () => {},
  rollback: () => {},
  checkpoint: null,
});

export function useConfigMode() {
  return useContext(ConfigContext);
}

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConfigState>('idle');
  const [checkpoint, setCheckpoint] = useState<string | null>(null);

  const enterEditMode = () => {
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15).replace(/(\d{8})(\d{6})/, '$1-$2');
    setCheckpoint(ts);
    setState('editing');
  };

  const commit = () => {
    setState('idle');
    setCheckpoint(null);
  };

  const rollback = () => {
    setState('idle');
    setCheckpoint(null);
  };

  return (
    <ConfigContext.Provider value={{ state, enterEditMode, commit, rollback, checkpoint }}>
      {children}
    </ConfigContext.Provider>
  );
}
