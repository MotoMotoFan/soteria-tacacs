import { useEffect, useState } from 'react';
import { Radio, Save, Server, Shield, Database, Globe, Clock, Info, Plug, LogIn, Loader2 } from 'lucide-react';
import { api, type LoggingConfig, type ServerSettings } from '../lib/api';
import { useApi, LoadState } from '../lib/useApi';
import { useConfigMode } from '../components/ConfigModeProvider';
import LdapCertsPanel from '../components/LdapCertsPanel';

// System Management > TACACS Settings.
//  - AAA log export: LIVE (staged + committed like entity pages).
//  - TLS / LDAP / DNS / listener: env-managed (server .env + restart), shown
//    read-only with their REAL current values so nothing is hidden.
export default function TacacsSettings() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold heading">TACACS+ Settings</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--s-muted)' }}>Server-side configuration for the Soteria TACACS+ server</p>
      </div>

      <SyslogExportSection />
      <ServerInfoSections />
    </div>
  );
}

// ============================ AAA log export (live) ============================

function SyslogExportSection() {
  const { editMode } = useConfigMode();
  const logging = useApi(api.getLogging);

  const [fileLog, setFileLog] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('514');
  const [timestamp, setTimestamp] = useState('RFC3164');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    if (logging.data && !dirty) {
      setFileLog(logging.data.fileLogEnabled);
      setEnabled(logging.data.syslogEnabled);
      setHost(logging.data.syslogHost);
      setPort(String(logging.data.syslogPort || 514));
      setTimestamp(logging.data.syslogTimestamp || 'RFC3164');
    }
  }, [logging.data, dirty]);

  const preview = (): string => {
    let out = '# 01-logging.cfg (generated)\n';
    if (fileLog) {
      out += '\n# Local daily files (read by the AAA Logs page)\nauthentication log = authentication_log\nauthorization log  = authorization_log\naccounting log     = accounting_log\n';
    }
    if (enabled) {
      out += `\n# Remote syslog export\nlog external_syslog {\n    destination = ${host || '<collector>'}:${port || '<port>'}\n    timestamp   = ${timestamp}\n}\n\nauthentication log = external_syslog\nauthorization log  = external_syslog\naccounting log     = external_syslog\n`;
    }
    if (!fileLog && !enabled) out += '\n# WARNING: no log destination enabled\n';
    return out;
  };

  const save = async () => {
    setError(null);
    setInfo(null);
    const cfg: LoggingConfig = {
      fileLogEnabled: fileLog,
      syslogEnabled: enabled,
      syslogHost: host.trim(),
      syslogPort: parseInt(port, 10) || 0,
      syslogTimestamp: timestamp,
    };
    if (!cfg.fileLogEnabled && !cfg.syslogEnabled) {
      setError('Enable at least one log destination (local files or remote syslog).');
      return;
    }
    if (cfg.syslogEnabled && !cfg.syslogHost) {
      setError('Collector host is required when syslog export is enabled.');
      return;
    }
    setSaving(true);
    try {
      await api.saveLogging(cfg);
      setDirty(false);
      setInfo('AAA logging change staged - review the diff and Commit in Edit Config mode to apply it.');
      await logging.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {error && (
        <div className="glass-card p-4 border-l-2 border-red-500">
          <pre className="text-sm text-red-400 whitespace-pre-wrap">{error}</pre>
        </div>
      )}
      {info && (
        <div className="glass-card p-4 border-l-2 border-emerald-500">
          <p className="text-sm text-emerald-400">{info}</p>
        </div>
      )}

      <div className="glass-card p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-9 h-9 rounded-lg bg-brand-purple/15 flex items-center justify-center">
            <Radio className="w-[18px] h-[18px] text-brand-magenta" />
          </div>
          <div>
            <h3 className="text-base font-semibold heading">AAA Logging</h3>
            <p className="text-xs" style={{ color: 'var(--s-muted)' }}>
              Choose where AAA events are stored: local daily files, remote syslog, or both.
            </p>
          </div>
          <span className="badge-success ml-auto">Live</span>
        </div>

        <LoadState loading={logging.loading} error={logging.error} onRetry={logging.reload}>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between py-1">
                <div>
                  <p className="text-sm font-medium" style={{ color: 'var(--s-text)' }}>Store logs locally (daily files)</p>
                  <p className="text-xs" style={{ color: 'var(--s-muted)' }}>Required for the AAA Logs page to show data</p>
                </div>
                <button
                  type="button"
                  onClick={() => { setFileLog(!fileLog); setDirty(true); }}
                  className={`relative w-11 h-6 rounded-full transition-colors ${fileLog ? 'bg-brand-magenta' : ''}`}
                  style={!fileLog ? { backgroundColor: 'var(--s-border)' } : undefined}
                >
                  <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${fileLog ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>

              {!fileLog && (
                <p className="text-xs text-amber-400">
                  Local files are off - the AAA Logs page will be empty; events go only to remote syslog.
                </p>
              )}

              <div className="flex items-center justify-between py-1" style={{ borderTop: '1px solid var(--s-border)' }}>
                <div>
                  <p className="text-sm font-medium" style={{ color: 'var(--s-text)' }}>Export to remote syslog</p>
                  <p className="text-xs" style={{ color: 'var(--s-muted)' }}>Authentication, authorization and accounting</p>
                </div>
                <button
                  type="button"
                  onClick={() => { setEnabled(!enabled); setDirty(true); }}
                  className={`relative w-11 h-6 rounded-full transition-colors ${enabled ? 'bg-brand-magenta' : ''}`}
                  style={!enabled ? { backgroundColor: 'var(--s-border)' } : undefined}
                >
                  <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>

              {enabled && (
                <>
                  <div>
                    <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Collector Host</label>
                    <input type="text" className="input-field font-mono" placeholder="e.g. 192.168.1.50 or syslog.lab.home" value={host} onChange={e => { setHost(e.target.value); setDirty(true); }} />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Collector Port</label>
                      <input type="number" min={1} max={65535} className="input-field font-mono" value={port} onChange={e => { setPort(e.target.value); setDirty(true); }} />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Timestamp Format</label>
                      <select className="select-field font-mono" value={timestamp} onChange={e => { setTimestamp(e.target.value); setDirty(true); }}>
                        <option value="RFC3164">RFC 3164 (BSD - Wazuh)</option>
                        <option value="RFC5424">RFC 5424</option>
                      </select>
                    </div>
                  </div>
                  <p className="text-xs" style={{ color: 'var(--s-muted)' }}>
                    RFC 3164 is the classic BSD syslog format most collectors (including Wazuh) expect. RFC 5424 is the newer structured format.
                  </p>
                </>
              )}

              <div className="pt-2">
                <button onClick={save} disabled={saving || !dirty} className="btn-primary flex items-center gap-2 text-sm">
                  <Save className="w-4 h-4" /> {saving ? 'Staging…' : 'Stage Change'}
                </button>
                {!editMode && dirty && (
                  <p className="text-xs mt-2 text-amber-400">
                    Enter Edit Config mode first (header button) - logging changes go through the same stage → diff → commit workflow.
                  </p>
                )}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-muted)' }}>Config Preview (01-logging.cfg)</label>
              <pre className="config-preview min-h-[240px] whitespace-pre">{preview()}</pre>
            </div>
          </div>
        </LoadState>
      </div>
    </>
  );
}

// ============================ Server settings ============================

function EnabledBadge({ on }: { on: boolean }) {
  return <span className={on ? 'badge-success' : 'badge-warning'}>{on ? 'Enabled' : 'Disabled'}</span>;
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle}
      className={`relative w-11 h-6 rounded-full transition-colors ${on ? 'bg-brand-magenta' : ''}`}
      style={!on ? { backgroundColor: 'var(--s-border)' } : undefined}>
      <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5" style={{ borderTop: '1px solid var(--s-border)' }}>
      <span className="text-sm shrink-0" style={{ color: 'var(--s-muted)' }}>{label}</span>
      <span className="text-sm font-mono text-right break-all" style={{ color: 'var(--s-text)' }}>{value}</span>
    </div>
  );
}

function Section({ icon: Icon, title, badge, children }: { icon: React.ElementType; title: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="glass-card p-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-9 h-9 rounded-lg bg-brand-purple/15 flex items-center justify-center">
          <Icon className="w-[18px] h-[18px] text-brand-magenta" />
        </div>
        <h3 className="text-base font-semibold heading">{title}</h3>
        {badge && <span className="ml-auto">{badge}</span>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>{label}</label>
      {children}
    </div>
  );
}

// LDAP + DNS are editable and apply live (staged like entity saves).
// TLS / listen port / timezone / log rotation are shown read-only for now
// (they require a container restart, which is the next step).
function ServerInfoSections() {
  const { editMode } = useConfigMode();
  const settings = useApi(api.getServerSettings);
  const [form, setForm] = useState<ServerSettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // LDAP test-bind / test-user state (against the current form values).
  const [connBusy, setConnBusy] = useState(false);
  const [connMsg, setConnMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testUser, setTestUser] = useState('');
  const [testPass, setTestPass] = useState('');
  const [userBusy, setUserBusy] = useState(false);
  const [userMsg, setUserMsg] = useState<{ ok: boolean; text: string; trace?: string[] } | null>(null);

  const testBind = async () => {
    if (!form) return;
    setConnBusy(true); setConnMsg(null);
    try {
      const r = await api.testMavisLdapConnection(form);
      setConnMsg({ ok: r.ok, text: r.message });
    } catch (e) {
      setConnMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setConnBusy(false);
    }
  };
  const testLogin = async () => {
    if (!form) return;
    setUserBusy(true); setUserMsg(null);
    try {
      const r = await api.testMavisLdapUser(form, testUser.trim(), testPass);
      const groups = r.groups && r.groups.length ? ` Groups: ${r.groups.join(', ')}.` : '';
      setUserMsg({ ok: r.ok, text: r.message + (r.ok && r.dn ? ` [${r.dn}]${groups}` : ''), trace: r.trace });
    } catch (e) {
      setUserMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setUserBusy(false);
    }
  };

  useEffect(() => {
    if (settings.data && !dirty) setForm({ ...settings.data, sharedKey: '', ldapPassword: '' });
  }, [settings.data, dirty]);

  const set = <K extends keyof ServerSettings>(k: K, v: ServerSettings[K]) => {
    setForm(f => f ? { ...f, [k]: v } : f);
    setDirty(true);
  };

  const save = async () => {
    if (!form) return;
    setError(null);
    setInfo(null);
    if (form.ldapEnabled && (!form.ldapHosts || !form.ldapUser || !form.ldapBase)) {
      setError('LDAP hosts, bind DN and search base are required when LDAP is enabled.');
      return;
    }
    setSaving(true);
    try {
      await api.saveServerSettings(form);
      setDirty(false);
      setInfo('Settings staged - review the diff and Commit in Edit Config mode. LDAP/DNS apply live; Listener/TLS/Log Management restart the tac_plus container.');
      await settings.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <LoadState loading={settings.loading} error={settings.error} onRetry={settings.reload}>
      {form && (
        <>
          {error && <div className="glass-card p-4 border-l-2 border-red-500"><pre className="text-sm text-red-400 whitespace-pre-wrap">{error}</pre></div>}
          {info && <div className="glass-card p-4 border-l-2 border-emerald-500"><p className="text-sm text-emerald-400">{info}</p></div>}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
            {/* LEFT: LDAP (many fields) */}
            <div className="space-y-6">
              <Section icon={Database} title="LDAP / Active Directory" badge={<><EnabledBadge on={form.ldapEnabled} /><span className="badge-warning ml-2" title="Enabling, disabling or reconfiguring LDAP restarts the TACACS server on commit (MAVIS starts only at daemon startup).">Restart on commit</span></>}>
                <div className="flex items-center justify-between py-1 mb-3">
                  <div>
                    <p className="text-sm font-medium" style={{ color: 'var(--s-text)' }}>Enable LDAP authentication</p>
                    <p className="text-xs" style={{ color: 'var(--s-muted)' }}>When off, only local users authenticate</p>
                  </div>
                  <Toggle on={form.ldapEnabled} onToggle={() => set('ldapEnabled', !form.ldapEnabled)} />
                </div>
                {form.ldapEnabled && (
                  <div className="space-y-4">
                    <Labeled label="Server Type">
                      <select className="select-field" value={form.ldapServerType || 'microsoft'} onChange={e => set('ldapServerType', e.target.value)}>
                        <option value="microsoft">Active Directory (microsoft)</option>
                        <option value="generic">OpenLDAP (generic)</option>
                      </select>
                    </Labeled>
                    <Labeled label="Hosts (space-separated)"><input className="input-field font-mono" placeholder="ldap01.corp.local ldap02.corp.local" value={form.ldapHosts} onChange={e => set('ldapHosts', e.target.value)} /></Labeled>
                    <Labeled label="Bind DN"><input className="input-field font-mono" placeholder="CN=svc-tacacs,OU=Service,DC=corp,DC=local" value={form.ldapUser} onChange={e => set('ldapUser', e.target.value)} /></Labeled>
                    <Labeled label="Bind Password"><input type="password" className="input-field font-mono" placeholder={form.ldapPasswordSet ? 'unchanged (leave blank to keep)' : 'set password'} value={form.ldapPassword ?? ''} onChange={e => set('ldapPassword', e.target.value)} /></Labeled>
                    <Labeled label="User Search Base"><input className="input-field font-mono" placeholder="OU=Users,DC=corp,DC=local" value={form.ldapBase} onChange={e => set('ldapBase', e.target.value)} /></Labeled>
                    <Labeled label="Group Search Base"><input className="input-field font-mono" placeholder="OU=Groups,DC=corp,DC=local" value={form.ldapBaseGroup} onChange={e => set('ldapBaseGroup', e.target.value)} /></Labeled>
                    <Labeled label="User Filter (optional)"><input className="input-field font-mono" placeholder="(&(objectClass=user)(sAMAccountName=%s))" value={form.ldapFilter} onChange={e => set('ldapFilter', e.target.value)} /></Labeled>
                    <Labeled label="Group Filter (optional)"><input className="input-field font-mono" placeholder={form.ldapServerType === 'generic' ? 'blank = (&(objectclass=groupOfNames)(member=%s))' : '(&(objectClass=group)(member=%s))'} value={form.ldapFilterGroup} onChange={e => set('ldapFilterGroup', e.target.value)} /></Labeled>
                    <Labeled label="Group Membership Attribute (optional)"><input className="input-field font-mono" placeholder={form.ldapServerType === 'generic' ? 'blank for OpenLDAP' : 'memberOf'} value={form.ldapTacMember} onChange={e => set('ldapTacMember', e.target.value)} /></Labeled>
                    {form.ldapServerType === 'generic' && (
                      <div className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs" style={{ backgroundColor: 'var(--s-bg)', border: '1px solid var(--s-border)', color: 'var(--s-muted)' }}>
                        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        OpenLDAP has no <span className="font-mono">memberOf</span> attribute by default. Leave Group Filter and Membership Attribute <strong>blank</strong>: group membership is resolved by searching the Group Search Base for entries where the user is a <span className="font-mono">member</span> (default <span className="font-mono">(&amp;(objectclass=groupOfNames)(member=%s))</span>). Set them only for a non-standard directory.
                      </div>
                    )}
                    <Labeled label="Connect Timeout (s)"><input type="number" min={1} className="input-field font-mono w-28" value={form.ldapConnectTimeout} onChange={e => set('ldapConnectTimeout', e.target.value)} /></Labeled>

                    <Labeled label="TLS Mode">
                      <select className="select-field" value={form.ldapTlsMode || 'none'} onChange={e => set('ldapTlsMode', e.target.value)}>
                        <option value="none">None (plaintext, port 389)</option>
                        <option value="ldaps">LDAPS (implicit TLS, port 636)</option>
                        <option value="starttls">StartTLS (upgrade on port 389)</option>
                      </select>
                    </Labeled>
                    {form.ldapTlsMode && form.ldapTlsMode !== 'none' && (
                      <div className="flex items-center justify-between py-1">
                        <div>
                          <p className="text-sm font-medium" style={{ color: 'var(--s-text)' }}>Verify server certificate</p>
                          <p className="text-xs" style={{ color: 'var(--s-muted)' }}>Requires the CA certificate in the LDAP TLS panel below</p>
                        </div>
                        <Toggle on={form.ldapTlsVerify} onToggle={() => set('ldapTlsVerify', !form.ldapTlsVerify)} />
                      </div>
                    )}

                    <div className="pt-4 space-y-3" style={{ borderTop: '1px solid var(--s-border)' }}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium heading">Test bind</span>
                        <button onClick={testBind} disabled={connBusy} className="btn-secondary text-xs flex items-center gap-1.5 shrink-0">
                          {connBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />} Test bind
                        </button>
                      </div>
                      {connMsg && <p className="text-xs break-all" style={{ color: connMsg.ok ? 'var(--s-chart-success)' : 'var(--s-chart-failure)' }}>{connMsg.text}</p>}
                      <p className="text-xs" style={{ color: 'var(--s-muted)' }}>Uses the values above. Leave the bind password blank to reuse the stored one.</p>

                      <div className="pt-3" style={{ borderTop: '1px solid var(--s-border)' }}>
                        <span className="text-sm font-medium heading">Test a user login</span>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                          <input className="input-field text-sm" placeholder="username (e.g. alice)" value={testUser} onChange={e => setTestUser(e.target.value)} autoComplete="off" />
                          <input type="password" className="input-field text-sm" placeholder="password" value={testPass} onChange={e => setTestPass(e.target.value)} autoComplete="off" />
                        </div>
                        <div className="flex items-center justify-between gap-2 mt-2">
                          {userMsg ? <p className="text-xs break-all" style={{ color: userMsg.ok ? 'var(--s-chart-success)' : 'var(--s-chart-failure)' }}>{userMsg.text}</p> : <span />}
                          <button onClick={testLogin} disabled={userBusy || !testUser.trim()} className="btn-secondary text-xs flex items-center gap-1.5 shrink-0">
                            {userBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogIn className="w-3.5 h-3.5" />} Test login
                          </button>
                        </div>
                        {userMsg?.trace && userMsg.trace.length > 0 && (
                          <pre className="mt-2 text-[11px] leading-relaxed font-mono rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all" style={{ backgroundColor: 'var(--s-code-bg)', color: 'var(--s-muted)', border: '1px solid var(--s-border)' }}>
                            {userMsg.trace.join('\n')}
                          </pre>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </Section>

              {form.ldapEnabled && <LdapCertsPanel />}

              <div>
                <button onClick={save} disabled={saving || !dirty} className="btn-primary flex items-center gap-2 text-sm">
                  <Save className="w-4 h-4" /> {saving ? 'Staging…' : 'Stage Settings Changes'}
                </button>
                {!editMode && dirty && (
                  <p className="text-xs mt-2 text-amber-400">Enter Edit Config mode first (header button), then Commit to apply.</p>
                )}
              </div>
            </div>

            {/* RIGHT: DNS (live) + restart-group (read-only) */}
            <div className="space-y-6">
              <Section icon={Globe} title="DNS" badge={<span className="badge-success">Live</span>}>
                <Labeled label="DNS Server (for reverse lookups)"><input className="input-field font-mono" placeholder="10.0.0.53 (blank = system default)" value={form.dnsServer} onChange={e => set('dnsServer', e.target.value)} /></Labeled>
                <div className="flex items-center justify-between py-1 mt-3">
                  <p className="text-sm font-medium" style={{ color: 'var(--s-text)' }}>Reverse DNS lookup</p>
                  <Toggle on={form.dnsReverseLookup} onToggle={() => set('dnsReverseLookup', !form.dnsReverseLookup)} />
                </div>
                <div className="mt-3">
                  <Labeled label="Query Timeout (s)"><input type="number" min={1} className="input-field font-mono w-28" value={form.dnsTimeout} onChange={e => set('dnsTimeout', e.target.value)} /></Labeled>
                </div>
              </Section>

              <div className="glass-card p-4 flex items-start gap-3 border-l-2 border-amber-500">
                <Info className="w-4 h-4 mt-0.5 shrink-0 text-amber-400" />
                <p className="text-xs" style={{ color: 'var(--s-text)' }}>
                  Changing these restarts the tac_plus container on commit (config files persist; only the
                  first deploy uses <span className="font-mono">.env</span>). TACACS auth is briefly interrupted (~10s).
                </p>
              </div>

              <Section icon={Server} title="Listener" badge={<span className="badge-warning">Restart</span>}>
                <div className="space-y-3">
                  <Labeled label="Listen Port"><input type="number" min={1} max={65535} className="input-field font-mono w-32" value={form.listenPort} onChange={e => set('listenPort', e.target.value)} /></Labeled>
                  <Labeled label="Timezone"><input className="input-field font-mono" placeholder="e.g. America/Sao_Paulo, UTC" value={form.timezone} onChange={e => set('timezone', e.target.value)} /></Labeled>
                  <Row label="Shared Key" value={form.sharedKeySet ? '•••••••• (managed via devices)' : 'not set'} />
                </div>
              </Section>

              <Section icon={Shield} title="TLS Encryption" badge={<><EnabledBadge on={form.tlsEnabled} /><span className="badge-warning ml-2">Restart</span></>}>
                <div className="flex items-center justify-between py-1">
                  <div>
                    <p className="text-sm font-medium" style={{ color: 'var(--s-text)' }}>TACACS+ over TLS (port {form.tlsPort})</p>
                    <p className="text-xs" style={{ color: 'var(--s-muted)' }}>Requires certs mounted at /etc/tac_plus-ng/tls/</p>
                  </div>
                  <Toggle on={form.tlsEnabled} onToggle={() => set('tlsEnabled', !form.tlsEnabled)} />
                </div>
              </Section>

              <Section icon={Clock} title="Log Management" badge={<span className="badge-warning">Restart</span>}>
                <div className="flex items-center justify-between py-1">
                  <p className="text-sm font-medium" style={{ color: 'var(--s-text)' }}>Weekly logrotate</p>
                  <Toggle on={form.logrotate} onToggle={() => set('logrotate', !form.logrotate)} />
                </div>
                <div className="flex items-center justify-between py-1" style={{ borderTop: '1px solid var(--s-border)' }}>
                  <p className="text-sm font-medium" style={{ color: 'var(--s-text)' }}>Monthly archive</p>
                  <Toggle on={form.monthlyArchive} onToggle={() => set('monthlyArchive', !form.monthlyArchive)} />
                </div>
              </Section>
            </div>
          </div>
        </>
      )}
    </LoadState>
  );
}
