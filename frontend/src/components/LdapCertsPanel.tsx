import { useEffect, useRef, useState } from 'react';
import { ShieldCheck, Upload, Trash2, Loader2, AlertCircle, Info } from 'lucide-react';
import { api, type LdapCertInfo } from '../lib/api';

// One shared TLS bundle drives BOTH LDAP paths: the TACACS+ MAVIS backend and
// the web UI LDAP sign-in read the same files from the config volume.
const SLOTS: { name: LdapCertInfo['name']; label: string; hint: string; accept: string }[] = [
  { name: 'ca', label: 'CA certificate', hint: 'Validates the directory server certificate (needed to turn on Verify).', accept: '.crt,.pem,.cer' },
  { name: 'client-cert', label: 'Client certificate', hint: 'Only for mutual TLS, when the directory demands a client certificate.', accept: '.crt,.pem,.cer' },
  { name: 'client-key', label: 'Client private key', hint: 'Private key matching the client certificate. Stored 0600 and never sent back.', accept: '.key,.pem' },
];

function fmtDate(iso?: string) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function LdapCertsPanel() {
  const [certs, setCerts] = useState<LdapCertInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  const load = async () => {
    setError(null);
    try {
      setCerts(await api.getLdapCerts());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const upload = async (name: string, file: File) => {
    setBusy(name); setError(null); setInfo(null);
    try {
      const pem = await file.text();
      await api.uploadLdapCert(name, pem);
      setInfo('Uploaded. Save and commit the LDAP settings to apply it.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (name: string) => {
    setBusy(name); setError(null); setInfo(null);
    try {
      await api.deleteLdapCert(name);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const byName = (n: string) => certs.find((c) => c.name === n);

  return (
    <div className="glass-card p-6">
      <div className="flex items-center gap-3 mb-1">
        <div className="w-9 h-9 rounded-lg bg-brand-purple/15 flex items-center justify-center">
          <ShieldCheck className="w-[18px] h-[18px] text-brand-magenta" />
        </div>
        <div>
          <h3 className="text-base font-semibold heading">LDAP TLS Certificates</h3>
          <p className="text-xs" style={{ color: 'var(--s-muted)' }}>Shared by TACACS+ LDAP and web UI LDAP sign-in</p>
        </div>
      </div>

      {error && <div className="mt-4 rounded-lg p-3 text-sm text-red-400" style={{ backgroundColor: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>{error}</div>}
      {info && <div className="mt-4 rounded-lg p-3 text-sm text-emerald-400" style={{ backgroundColor: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)' }}>{info}</div>}

      {loading ? (
        <p className="text-sm mt-4" style={{ color: 'var(--s-muted)' }}>Loading…</p>
      ) : (
        <div className="mt-4 space-y-4">
          {SLOTS.map((slot) => {
            const c = byName(slot.name);
            const present = c?.present ?? false;
            return (
              <div key={slot.name} className="pt-4 first:pt-0" style={{ borderTop: '1px solid var(--s-border)' }}>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium" style={{ color: 'var(--s-text)' }}>{slot.label}</span>
                      {present
                        ? <span className={c?.expired ? 'badge-danger' : 'badge-success'}>{c?.expired ? 'Expired' : 'Installed'}</span>
                        : <span className="badge-warning">Not set</span>}
                    </div>
                    <p className="text-xs mt-1" style={{ color: 'var(--s-muted)' }}>{slot.hint}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <input
                      ref={(el) => { inputs.current[slot.name] = el; }}
                      type="file"
                      accept={slot.accept}
                      className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(slot.name, f); e.target.value = ''; }}
                    />
                    <button onClick={() => inputs.current[slot.name]?.click()} disabled={busy === slot.name} className="btn-secondary text-xs flex items-center gap-1.5">
                      {busy === slot.name ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Upload
                    </button>
                    {present && (
                      <button onClick={() => void remove(slot.name)} disabled={busy === slot.name} className="btn-secondary text-xs flex items-center gap-1.5">
                        <Trash2 className="w-3.5 h-3.5" /> Remove
                      </button>
                    )}
                  </div>
                </div>

                {c?.error && (
                  <p className="text-xs mt-2 flex items-center gap-1.5 text-red-400"><AlertCircle className="w-3.5 h-3.5 shrink-0" />{c.error}</p>
                )}
                {present && c?.subject && (
                  <div className="mt-2 text-xs font-mono rounded-lg p-3 space-y-0.5 overflow-x-auto" style={{ backgroundColor: 'var(--s-code-bg)', color: 'var(--s-muted)', border: '1px solid var(--s-border)' }}>
                    <div>subject: {c.subject}</div>
                    <div>issuer:  {c.issuer}</div>
                    <div style={c.expired ? { color: 'var(--s-chart-failure)' } : undefined}>
                      expires: {fmtDate(c.notAfter)}{c.expired ? '  (EXPIRED)' : ''}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          <div className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs" style={{ backgroundColor: 'var(--s-bg)', border: '1px solid var(--s-border)', color: 'var(--s-muted)' }}>
            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            Upload PEM files. After changing the bundle, save and commit the LDAP settings so the TACACS server picks it up (LDAP changes restart the daemon). A client certificate is only needed when the directory is set to <span className="font-mono">olcTLSVerifyClient: demand</span>.
          </div>
        </div>
      )}
    </div>
  );
}
