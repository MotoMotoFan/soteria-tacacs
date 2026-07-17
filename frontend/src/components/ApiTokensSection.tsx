import { useEffect, useState } from 'react';
import { KeyRound, Plus, Trash2, Copy, Check, AlertCircle, Loader2, ShieldAlert, BookOpen } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, type ApiToken, type ApiScope } from '../lib/api';
import { useAuth } from './AuthProvider';
import ScopeMatrix from './ScopeMatrix';

const EXPIRY_PRESETS = [
  { label: '30 days', days: 30 },
  { label: '7 days', days: 7 },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 365 },
  { label: 'Custom date', days: -1 },
  { label: 'Never expires', days: 0 },
];

function fmtDate(unix: number): string {
  if (!unix) return 'Never';
  return new Date(unix * 1000).toLocaleString();
}

export default function ApiTokensSection() {
  const { isAdmin } = useAuth();
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [scopes, setScopes] = useState<ApiScope[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expiryChoice, setExpiryChoice] = useState(30); // days; -1 custom, 0 never
  const [customDate, setCustomDate] = useState('');
  const [creating, setCreating] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const [t, s] = await Promise.all([api.listApiTokens(), api.listApiScopes()]);
      setTokens(t);
      setScopes(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const resetForm = () => {
    setName(''); setSelected(new Set()); setExpiryChoice(30); setCustomDate('');
  };

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      let expiresInDays = 0;
      let expiresAt = 0;
      if (expiryChoice === -1) {
        if (!customDate) throw new Error('Pick a custom expiry date.');
        expiresAt = Math.floor(new Date(customDate).getTime() / 1000);
        if (expiresAt <= Date.now() / 1000) throw new Error('Expiry must be in the future.');
      } else {
        expiresInDays = expiryChoice; // 0 = never
      }
      const res = await api.createApiToken({ name: name.trim(), scopes: [...selected], expiresInDays, expiresAt });
      setNewSecret(res.secret);
      setShowForm(false);
      resetForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (t: ApiToken) => {
    if (!window.confirm(`Revoke token "${t.name}"? Any client using it will immediately lose access.`)) return;
    try {
      await api.revokeApiToken(t.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const copySecret = async () => {
    if (!newSecret) return;
    await navigator.clipboard.writeText(newSecret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="glass-card p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-1">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-brand-purple/15 flex items-center justify-center shrink-0">
            <KeyRound className="w-[18px] h-[18px] text-brand-magenta" />
          </div>
          <div>
            <h3 className="text-base font-semibold heading">API Tokens</h3>
            <p className="text-xs" style={{ color: 'var(--s-muted)' }}>
              Long-lived scoped credentials for scripts and integrations. {isAdmin ? 'You see every user’s tokens.' : 'You manage your own tokens.'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link to="/api-docs" className="btn-secondary flex items-center gap-2 text-sm">
            <BookOpen className="w-4 h-4" /> API Docs
          </Link>
          <button onClick={() => { setShowForm((v) => !v); setNewSecret(null); }} className="btn-primary flex items-center gap-2 text-sm">
            <Plus className="w-4 h-4" /> New Token
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 px-3 py-2.5 my-4 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {/* One-time secret display */}
      {newSecret && (
        <div className="my-4 p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/25">
          <div className="flex items-start gap-2 mb-2">
            <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-emerald-400" />
            <p className="text-sm text-emerald-400">
              Copy this token now. It is shown <strong>once</strong> and cannot be retrieved again.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <code className="config-preview flex-1 break-all">{newSecret}</code>
            <button onClick={copySecret} className="btn-secondary flex items-center gap-1.5 text-sm shrink-0">
              {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="text-xs mt-2" style={{ color: 'var(--s-muted)' }}>
            Use it as a bearer token: <code className="font-mono">Authorization: Bearer {newSecret.slice(0, 8)}…</code> against <code className="font-mono">/agent/api/…</code>
          </p>
        </div>
      )}

      {/* Create form */}
      {showForm && (
        <div className="my-4 p-4 rounded-lg space-y-4" style={{ backgroundColor: 'var(--s-bg)', border: '1px solid var(--s-border)' }}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Token name</label>
              <input className="input-field" placeholder="e.g. ansible-ci" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Expires</label>
              <select className="select-field" value={expiryChoice} onChange={(e) => setExpiryChoice(Number(e.target.value))}>
                {EXPIRY_PRESETS.map((p) => <option key={p.label} value={p.days}>{p.label}</option>)}
              </select>
              {expiryChoice === -1 && (
                <input type="datetime-local" className="input-field mt-2" value={customDate} onChange={(e) => setCustomDate(e.target.value)} />
              )}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium" style={{ color: 'var(--s-text)' }}>Scopes ({selected.size} selected)</label>
              <span className="text-xs" style={{ color: 'var(--s-muted)' }}>A token can only call endpoints matching its scopes.</span>
            </div>
            <ScopeMatrix scopes={scopes} selected={selected} onChange={setSelected} />
          </div>

          <div className="flex items-center justify-end gap-2">
            <button onClick={() => { setShowForm(false); resetForm(); }} className="btn-ghost text-sm">Cancel</button>
            <button onClick={create} disabled={creating || !name.trim() || selected.size === 0} className="btn-primary flex items-center gap-2 text-sm">
              {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create token
            </button>
          </div>
        </div>
      )}

      {/* Token list */}
      {loading ? (
        <div className="flex items-center justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-brand-magenta" /></div>
      ) : tokens.length === 0 ? (
        <div className="py-10 text-center text-sm" style={{ color: 'var(--s-muted)' }}>No API tokens yet. Create one to call the API from scripts.</div>
      ) : (
        <div className="overflow-x-auto mt-4">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr>
                <th className="table-header">Name</th>
                {isAdmin && <th className="table-header">Owner</th>}
                <th className="table-header">Scopes</th>
                <th className="table-header">Expires</th>
                <th className="table-header">Last used</th>
                <th className="table-header text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => {
                const expired = t.expires !== 0 && Date.now() / 1000 >= t.expires;
                return (
                  <tr key={t.id} className="table-row">
                    <td className="table-cell">
                      <span className="font-medium heading">{t.name}</span>
                      <span className="block font-mono text-xs" style={{ color: 'var(--s-muted)' }}>{t.preview}</span>
                    </td>
                    {isAdmin && <td className="table-cell text-sm" style={{ color: 'var(--s-muted)' }}>{t.owner}</td>}
                    <td className="table-cell">
                      <div className="flex flex-wrap gap-1 max-w-md">
                        {t.scopes.slice(0, 6).map((s) => (
                          <span key={s} className="badge-readonly font-mono text-[10px]">{s}</span>
                        ))}
                        {t.scopes.length > 6 && <span className="text-xs" style={{ color: 'var(--s-muted)' }}>+{t.scopes.length - 6}</span>}
                      </div>
                    </td>
                    <td className="table-cell text-sm">
                      {expired ? <span className="badge-danger">Expired</span> : <span style={{ color: 'var(--s-muted)' }}>{fmtDate(t.expires)}</span>}
                    </td>
                    <td className="table-cell text-sm" style={{ color: 'var(--s-muted)' }}>{fmtDate(t.lastUsed)}</td>
                    <td className="table-cell text-right">
                      <button onClick={() => revoke(t)} className="btn-danger text-xs inline-flex items-center gap-1.5 py-1 px-2">
                        <Trash2 className="w-3.5 h-3.5" /> Revoke
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
