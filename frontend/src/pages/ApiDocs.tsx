import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Sun, Moon } from 'lucide-react';
import { ApiReferenceReact } from '@scalar/api-reference-react';
import '@scalar/api-reference-react/style.css';
import { api } from '../lib/api';
import { useApi, LoadState } from '../lib/useApi';
import { buildOpenApi } from '../lib/openapi';
import { useTheme } from '../components/ThemeProvider';

// Standalone, full-screen API reference (rendered outside the dashboard chrome).
// Scalar supplies search, code samples, a download button, and an interactive
// "Try it" console (paste a token, send real requests through the /agent proxy).
export default function ApiDocs() {
  const { theme, toggle } = useTheme();
  const scopes = useApi(() => api.listApiScopes(), []);
  const spec = useMemo(() => (scopes.data ? buildOpenApi(scopes.data) : null), [scopes.data]);

  return (
    <div className="h-screen flex flex-col" style={{ backgroundColor: 'var(--s-bg)' }}>
      {/* Slim top bar with a way back to the app */}
      <header
        className="h-14 flex items-center justify-between px-4 shrink-0"
        style={{ backgroundColor: 'var(--s-surface)', borderBottom: '1px solid var(--s-border)' }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <img src="/assets/media-logo.png" alt="Soteria" className="w-8 h-8 rounded-lg shrink-0 object-contain" />
          <div className="flex flex-col min-w-0 leading-tight">
            <span className="text-sm font-bold tracking-wide truncate heading">SOTERIA API</span>
            <span className="text-[10px] font-medium tracking-widest uppercase" style={{ color: 'var(--s-muted)' }}>TACACS+ Management</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={toggle}
            className="p-2 rounded-lg transition-colors"
            style={{ color: 'var(--s-muted)' }}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? <Sun className="w-[18px] h-[18px]" /> : <Moon className="w-[18px] h-[18px]" />}
          </button>
          <Link to="/" className="btn-secondary text-sm flex items-center gap-2">
            <ArrowLeft className="w-4 h-4" /> Back to Soteria
          </Link>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <LoadState loading={scopes.loading} error={scopes.error} onRetry={scopes.reload}>
          {spec && (
            <ApiReferenceReact
              configuration={{
                content: spec as Record<string, unknown>,
                darkMode: theme === 'dark',
                withDefaultFonts: false,
                hideModels: false,
              }}
            />
          )}
        </LoadState>
      </div>
    </div>
  );
}
