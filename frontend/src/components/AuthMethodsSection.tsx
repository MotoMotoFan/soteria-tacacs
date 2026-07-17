import { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, Loader2, AlertCircle, Lock, Info, Plug, LogIn } from 'lucide-react';
import { useAuth } from './AuthProvider';
import { api } from '../lib/api';
import { listAuthSettings, saveAuthSetting, enforceLocalUsers, type AuthMethod, type AuthSetting } from '../lib/authsettings';
import LdapCertsPanel from './LdapCertsPanel';

type Field = {
  key: string;
  label: string;
  type?: 'text' | 'password' | 'number' | 'bool' | 'select';
  placeholder?: string;
  options?: { value: string; label: string }[];
};

const TABS: { method: AuthMethod; label: string }[] = [
  { method: 'local', label: 'Local' },
  { method: 'ldap', label: 'LDAP' },
  { method: 'oidc', label: 'OIDC' },
  { method: 'sso', label: 'SSO (SAML)' },
];

const FIELDS: Record<AuthMethod, Field[]> = {
  local: [],
  ldap: [
    { key: 'host', label: 'Host', placeholder: 'ldap.example.com' },
    { key: 'port', label: 'Port', type: 'number', placeholder: '389 for none/StartTLS, 636 for LDAPS' },
    {
      key: 'tlsMode', label: 'TLS mode', type: 'select', options: [
        { value: 'none', label: 'None (plaintext, port 389)' },
        { value: 'ldaps', label: 'LDAPS (implicit TLS, port 636)' },
        { value: 'starttls', label: 'StartTLS (upgrade on port 389)' },
      ],
    },
    { key: 'tlsVerify', label: 'Verify the server certificate (needs a CA certificate below)', type: 'bool' },
    { key: 'baseDn', label: 'Base DN', placeholder: 'dc=example,dc=com' },
    { key: 'bindDn', label: 'Bind DN', placeholder: 'cn=svc,dc=example,dc=com' },
    { key: 'bindPassword', label: 'Bind password', type: 'password' },
    { key: 'userFilter', label: 'User filter', placeholder: '(uid=%s)' },
    { key: 'groupBaseDn', label: 'Group base DN', placeholder: 'ou=groups,dc=example,dc=com' },
    { key: 'groupFilter', label: 'Group filter (reverse search)', placeholder: '(&(objectclass=groupOfNames)(member=%s))' },
    { key: 'memberAttr', label: 'Group membership attribute', placeholder: 'memberOf for AD, blank for OpenLDAP' },
    { key: 'syncGroups', label: 'Map LDAP groups to access groups of the same name', type: 'bool' },
  ],
  oidc: [
    { key: 'issuer', label: 'Issuer URL', placeholder: 'https://idp.example.com/realms/main' },
    { key: 'clientId', label: 'Client ID' },
    { key: 'clientSecret', label: 'Client secret', type: 'password' },
    { key: 'scopes', label: 'Scopes', placeholder: 'openid profile email' },
  ],
  sso: [
    { key: 'domain', label: 'Email domain', placeholder: 'example.com' },
    { key: 'metadataUrl', label: 'IdP metadata URL' },
  ],
};

const NOTES: Record<AuthMethod, string> = {
  local: 'Local email + password (with mandatory MFA) is always available. The Administrator account can never be disabled.',
  ldap: 'Direct LDAP: the Soteria agent binds your directory to validate credentials at sign-in — no third-party bridge. Fill in the server + bind account, test the connection and a user, then enable. On login the user gets a Read Only session unless "sync groups" matches a directory group to an access group of the same name.',
  oidc: 'Enabling OIDC requires configuring the provider in GoTrue (env vars) and restarting the auth service. Saved here as reference; users who sign in this way land in the Read Only group by default.',
  sso: 'SAML SSO requires GOTRUE_SAML_ENABLED on the auth server; once enabled the IdP can be registered. Saved here as reference; SSO users default to the Read Only group.',
};

export default function AuthMethodsSection() {
  const { isAdmin } = useAuth();
  const [settings, setSettings] = useState<Record<string, AuthSetting>>({});
  const [active, setActive] = useState<AuthMethod>('local');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // LDAP test state
  const [connMsg, setConnMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [connBusy, setConnBusy] = useState(false);
  const [ldapUser, setLdapUser] = useState('');
  const [ldapPass, setLdapPass] = useState('');
  const [userMsg, setUserMsg] = useState<{ ok: boolean; text: string; trace?: string[] } | null>(null);
  const [userBusy, setUserBusy] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const rows = await listAuthSettings();
      setSettings(Object.fromEntries(rows.map((r) => [r.method, r])));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { if (isAdmin) void load(); }, [isAdmin]);

  const cur = settings[active] ?? { method: active, enabled: active === 'local', config: {} };
  const anyExternal = useMemo(() => (['ldap', 'oidc', 'sso'] as AuthMethod[]).some((m) => settings[m]?.enabled), [settings]);

  if (!isAdmin) return null;

  const setField = (key: string, value: string | boolean) =>
    setSettings((prev) => ({ ...prev, [active]: { ...cur, config: { ...cur.config, [key]: value } } }));
  const setEnabled = (v: boolean) => setSettings((prev) => ({ ...prev, [active]: { ...cur, enabled: v } }));

  const save = async () => {
    setSaving(true); setError(null); setSaved(false);
    try {
      const enabledNow = active === 'local' ? true : cur.enabled;
      await saveAuthSetting(active, enabledNow, cur.config);
      // Recompute whether any external method is on after this save, then
      // disable/enable non-admin local users to match the policy.
      const next = { ...settings, [active]: { ...cur, enabled: enabledNow } };
      const nowExternal = (['ldap', 'oidc', 'sso'] as AuthMethod[]).some((m) => next[m]?.enabled);
      await enforceLocalUsers(nowExternal);
      setSaved(true);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const testConn = async () => {
    setConnBusy(true); setConnMsg(null);
    try {
      const r = await api.testLdapConnection(cur.config);
      setConnMsg({ ok: r.ok, text: r.message });
    } catch (e) {
      setConnMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setConnBusy(false);
    }
  };
  const testUser = async () => {
    setUserBusy(true); setUserMsg(null);
    try {
      const r = await api.testLdapUser(cur.config, ldapUser.trim(), ldapPass);
      const groups = r.groups && r.groups.length ? ` Groups: ${r.groups.join(', ')}.` : '';
      setUserMsg({ ok: r.ok, text: r.message + (r.ok && r.dn ? ` [${r.dn}]${groups}` : ''), trace: r.trace });
    } catch (e) {
      setUserMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setUserBusy(false);
    }
  };

  return (
    <div className="glass-card p-6">
      <div className="flex items-center gap-3 mb-1">
        <div className="w-9 h-9 rounded-lg bg-brand-purple/15 flex items-center justify-center shrink-0">
          <ShieldCheck className="w-[18px] h-[18px] text-brand-magenta" />
        </div>
        <div>
          <h3 className="text-base font-semibold heading">Authentication</h3>
          <p className="text-xs" style={{ color: 'var(--s-muted)' }}>How users sign in to this dashboard.</p>
        </div>
      </div>

      {anyExternal && (
        <div className="flex items-start gap-2 px-3 py-2.5 mt-4 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-400">
          <Lock className="w-4 h-4 shrink-0 mt-0.5" />
          An external method is enabled, so local users are disabled — except the Administrator account, which always stays active.
        </div>
      )}

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 mt-4 mb-4 p-1 rounded-lg" style={{ backgroundColor: 'var(--s-bg)', border: '1px solid var(--s-border)' }}>
        {TABS.map((t) => {
          const on = settings[t.method]?.enabled ?? t.method === 'local';
          const isActive = active === t.method;
          return (
            <button key={t.method} onClick={() => { setActive(t.method); setSaved(false); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors"
              style={{ backgroundColor: isActive ? 'var(--s-surface)' : 'transparent', color: isActive ? 'var(--s-heading)' : 'var(--s-muted)' }}>
              {t.label}
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: on ? 'var(--s-chart-success)' : 'var(--s-border)' }} />
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-brand-magenta" /></div>
      ) : (
        <div className="space-y-4">
          {error && (
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
              <AlertCircle className="w-4 h-4 shrink-0" /> {error}
            </div>
          )}

          <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg text-xs" style={{ backgroundColor: 'var(--s-bg)', border: '1px solid var(--s-border)', color: 'var(--s-muted)' }}>
            <Info className="w-4 h-4 shrink-0 mt-0.5" /> {NOTES[active]}
          </div>

          {/* Enabled toggle */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium" style={{ color: 'var(--s-text)' }}>
              {active === 'local' ? 'Always enabled' : 'Enabled'}
            </span>
            <button
              onClick={() => active !== 'local' && setEnabled(!cur.enabled)}
              disabled={active === 'local'}
              className="relative w-11 h-6 rounded-full transition-colors disabled:opacity-60"
              style={{ backgroundColor: (active === 'local' || cur.enabled) ? 'var(--brand-magenta, #ac4886)' : 'var(--s-border)' }}
            >
              <span className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform"
                style={{ transform: (active === 'local' || cur.enabled) ? 'translateX(20px)' : 'none' }} />
            </button>
          </div>

          {/* Fields */}
          {FIELDS[active].map((f) => (
            <div key={f.key}>
              {f.type === 'bool' ? (
                <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--s-text)' }}>
                  <input type="checkbox" className="accent-brand-magenta w-4 h-4"
                    checked={Boolean(cur.config[f.key])} onChange={(e) => setField(f.key, e.target.checked)} />
                  {f.label}
                </label>
              ) : f.type === 'select' ? (
                <>
                  <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>{f.label}</label>
                  <select className="select-field text-sm" value={String(cur.config[f.key] ?? f.options?.[0]?.value ?? '')}
                    onChange={(e) => setField(f.key, e.target.value)}>
                    {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </>
              ) : (
                <>
                  <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>{f.label}</label>
                  <input
                    type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
                    className="input-field font-mono text-sm"
                    placeholder={f.placeholder}
                    value={String(cur.config[f.key] ?? '')}
                    onChange={(e) => setField(f.key, e.target.value)}
                  />
                </>
              )}
            </div>
          ))}

          {active === 'ldap' && (
            <div className="space-y-3 rounded-lg p-3" style={{ backgroundColor: 'var(--s-bg)', border: '1px solid var(--s-border)' }}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium heading">Test connection</span>
                <button onClick={testConn} disabled={connBusy} className="btn-secondary text-xs flex items-center gap-1.5 shrink-0">
                  {connBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />} Test
                </button>
              </div>
              {connMsg && <p className={`text-xs ${connMsg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{connMsg.text}</p>}

              <div className="pt-3" style={{ borderTop: '1px solid var(--s-border)' }}>
                <span className="text-sm font-medium heading">Test a user login</span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                  <input className="input-field text-sm" placeholder="username (e.g. alice)" value={ldapUser} onChange={(e) => setLdapUser(e.target.value)} autoComplete="off" />
                  <input type="password" className="input-field text-sm" placeholder="password" value={ldapPass} onChange={(e) => setLdapPass(e.target.value)} autoComplete="off" />
                </div>
                <div className="flex items-center justify-between gap-2 mt-2">
                  {userMsg ? <p className={`text-xs break-all ${userMsg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{userMsg.text}</p> : <span />}
                  <button onClick={testUser} disabled={userBusy || !ldapUser.trim()} className="btn-secondary text-xs flex items-center gap-1.5 shrink-0">
                    {userBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogIn className="w-3.5 h-3.5" />} Test login
                  </button>
                </div>
                {userMsg?.trace && userMsg.trace.length > 0 && (
                  <pre
                    className="mt-2 text-[11px] leading-relaxed font-mono rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all"
                    style={{ backgroundColor: 'var(--s-code-bg)', color: 'var(--s-muted)', border: '1px solid var(--s-border)' }}
                  >
                    {userMsg.trace.join('\n')}
                  </pre>
                )}
              </div>
            </div>
          )}

          {active === 'ldap' && <LdapCertsPanel />}

          {(active === 'oidc' || active === 'sso') && (
            <p className="text-xs" style={{ color: 'var(--s-muted)' }}>
              Callback URL for the IdP: <code className="font-mono">{window.location.origin}/supabase/auth/v1/callback</code>
            </p>
          )}

          {saved && <p className="text-sm text-emerald-400">Saved.</p>}

          <div className="flex justify-end pt-1">
            <button onClick={save} disabled={saving} className="btn-primary flex items-center gap-2 text-sm">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />} Save {TABS.find((t) => t.method === active)?.label}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
