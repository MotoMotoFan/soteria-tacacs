import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Globe, Network, Plus, Trash2, ChevronRight, Loader2, AlertCircle, DatabaseZap } from 'lucide-react';
import { api, type DnsZone } from '../lib/api';
import { useApi, LoadState } from '../lib/useApi';
import Modal from '../components/Modal';

// Compute the in-addr.arpa zone name for an IPv4 CIDR (/8, /16, /24).
function reverseZoneName(cidr: string): string | null {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr.trim());
  if (!m) return null;
  const o = [+m[1], +m[2], +m[3], +m[4]];
  const prefix = +m[5];
  if (o.some((x) => x > 255) || prefix > 32) return null;
  const take = prefix >= 24 ? 3 : prefix >= 16 ? 2 : prefix >= 8 ? 1 : 0;
  if (take === 0) return null;
  return o.slice(0, take).reverse().join('.') + '.in-addr.arpa';
}

export default function DnsZones({ kind }: { kind: 'forward' | 'reverse' }) {
  const nav = useNavigate();
  const zones = useApi(() => api.listDnsZones(), []);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showScan, setShowScan] = useState(false);

  const rows = (zones.data ?? []).filter((z) => z.kind === kind);
  const title = kind === 'forward' ? 'Authoritative Domains' : 'Reverse Zones';
  const subtitle = kind === 'forward'
    ? 'Forward zones served by the local BIND9. Open a domain to manage its records.'
    : 'Reverse (PTR) zones. Open a zone to manage its pointer records.';
  const Icon = kind === 'forward' ? Globe : Network;

  const remove = async (z: DnsZone, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(`Delete zone "${z.name}" and all its records? This reloads BIND.`)) return;
    try { await api.deleteDnsZone(z.name); zones.reload(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-brand-purple/15 flex items-center justify-center shrink-0">
            <Icon className="w-5 h-5 text-brand-magenta" />
          </div>
          <div>
            <h1 className="text-2xl font-bold heading">{title}</h1>
            <p className="text-sm mt-0.5" style={{ color: 'var(--s-muted)' }}>{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {kind === 'reverse' && (
            <button onClick={() => setShowScan(true)} className="btn-secondary flex items-center gap-2">
              <DatabaseZap className="w-4 h-4" /> Scan Source of Truth
            </button>
          )}
          <button onClick={() => setShowNew(true)} className="btn-primary flex items-center gap-2">
            <Plus className="w-4 h-4" /> {kind === 'forward' ? 'New Domain' : 'New Reverse Zone'}
          </button>
        </div>
      </div>

      {error && (
        <div className="glass-card p-4 border-l-2 border-red-500">
          <pre className="text-sm text-red-400 whitespace-pre-wrap">{error}</pre>
        </div>
      )}

      <LoadState loading={zones.loading} error={zones.error} onRetry={zones.reload}>
        {rows.length === 0 ? (
          <div className="glass-card py-12 text-center" style={{ color: 'var(--s-muted)' }}>
            No {kind === 'forward' ? 'authoritative domains' : 'reverse zones'} yet.
          </div>
        ) : (
          <div className="glass-card overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead>
                <tr>
                  <th className="table-header">Zone</th>
                  <th className="table-header">{kind === 'forward' ? 'Primary NS' : 'Network'}</th>
                  <th className="table-header">Records</th>
                  <th className="table-header">Serial</th>
                  <th className="table-header text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((z) => (
                  <tr
                    key={z.name}
                    className="table-row cursor-pointer"
                    onClick={() => nav(`/dns/zone/${encodeURIComponent(z.name)}`)}
                  >
                    <td className="table-cell font-mono font-medium heading">{z.name}</td>
                    <td className="table-cell font-mono text-sm" style={{ color: 'var(--s-muted)' }}>
                      {kind === 'forward' ? z.primaryNs : (z.network ?? '-')}
                    </td>
                    <td className="table-cell text-sm">{z.records?.length ?? 0}</td>
                    <td className="table-cell font-mono text-xs" style={{ color: 'var(--s-muted)' }}>{z.serial}</td>
                    <td className="table-cell text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={(e) => remove(z, e)} className="btn-ghost p-1.5 hover:text-red-400" title="Delete zone">
                          <Trash2 className="w-4 h-4" />
                        </button>
                        <ChevronRight className="w-4 h-4" style={{ color: 'var(--s-muted)' }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </LoadState>

      <NewZoneModal
        open={showNew}
        kind={kind}
        onClose={() => setShowNew(false)}
        onCreated={(name) => { setShowNew(false); nav(`/dns/zone/${encodeURIComponent(name)}`); }}
      />
      <ScanReverseModal open={showScan} onClose={() => setShowScan(false)} onDone={() => zones.reload()} />
    </div>
  );
}

interface ReversePlan { dryRun: boolean; scannedPrefixes: number; toCreate: string[]; existing: string[]; skipped: string[]; created: string[]; errors: string[] }

function ScanReverseModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [tag, setTag] = useState('dns-entry');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<ReversePlan | null>(null);
  const [applied, setApplied] = useState(false);

  useEffect(() => { if (open) { setTag('dns-entry'); setError(null); setPlan(null); setApplied(false); } }, [open]);

  const run = async (dryRun: boolean) => {
    setBusy(true); setError(null);
    try {
      const res = await api.scanReverseZones(tag.trim(), dryRun);
      // Guard against nil slices arriving as JSON null (older agent builds):
      // the render calls .length/.join on each of these.
      setPlan({
        dryRun: res.dryRun,
        scannedPrefixes: res.scannedPrefixes ?? 0,
        toCreate: res.toCreate ?? [],
        existing: res.existing ?? [],
        skipped: res.skipped ?? [],
        created: res.created ?? [],
        errors: res.errors ?? [],
      });
      setApplied(!dryRun);
      if (!dryRun) onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const showPreviewBtn = !plan || applied;

  return (
    <Modal open={open} onClose={onClose} title="Scan Source of Truth (NetBox)">
      <div className="space-y-4">
        <p className="text-sm" style={{ color: 'var(--s-muted)' }}>
          Previews the reverse zones for NetBox prefixes carrying this tag. Nothing is created until you click Apply.
        </p>
        {error && (
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
            <AlertCircle className="w-4 h-4 shrink-0" /> {error}
          </div>
        )}
        <div>
          <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Prefix tag</label>
          <input className="input-field font-mono" value={tag} onChange={(e) => { setTag(e.target.value); setPlan(null); setApplied(false); }} placeholder="dns-entry" />
        </div>
        {plan && (
          <div className="rounded-lg p-3 text-sm space-y-1" style={{ backgroundColor: 'var(--s-bg)', border: '1px solid var(--s-border)', color: 'var(--s-text)' }}>
            <p>Scanned {plan.scannedPrefixes} prefix(es).</p>
            {applied
              ? <p className="text-emerald-400">Created {plan.created.length} zone(s){plan.created.length > 0 && `: ${plan.created.join(', ')}`}</p>
              : <p className="text-amber-400">Will create {plan.toCreate.length} zone(s){plan.toCreate.length > 0 && `: ${plan.toCreate.join(', ')}`}</p>}
            <p style={{ color: 'var(--s-muted)' }}>Already exist: {plan.existing.length}</p>
            {plan.skipped.length > 0 && <p style={{ color: 'var(--s-muted)' }}>Skipped (not /8,/16,/24): {plan.skipped.join(', ')}</p>}
            {plan.errors.length > 0 && <p className="text-red-400">Errors: {plan.errors.join('; ')}</p>}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="btn-secondary">Close</button>
          {showPreviewBtn ? (
            <button onClick={() => run(true)} disabled={busy || !tag.trim()} className="btn-primary flex items-center gap-2">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <DatabaseZap className="w-4 h-4" />} Preview
            </button>
          ) : (
            <button onClick={() => run(false)} disabled={busy || plan.toCreate.length === 0} className="btn-primary flex items-center gap-2">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <DatabaseZap className="w-4 h-4" />} Apply — create {plan.toCreate.length}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function NewZoneModal({ open, kind, onClose, onCreated }: {
  open: boolean; kind: 'forward' | 'reverse'; onClose: () => void; onCreated: (name: string) => void;
}) {
  const [domain, setDomain] = useState('');
  const [cidr, setCidr] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (open) { setDomain(''); setCidr(''); setError(null); } }, [open]);

  const reverseName = kind === 'reverse' ? reverseZoneName(cidr) : null;

  const create = async () => {
    setSaving(true); setError(null);
    try {
      const name = kind === 'forward' ? domain.trim() : reverseName;
      if (!name) throw new Error(kind === 'forward' ? 'Enter a domain name.' : 'Enter a valid IPv4 CIDR (e.g. 192.168.2.0/24).');
      await api.createDnsZone({ name });
      onCreated(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={kind === 'forward' ? 'New Authoritative Domain' : 'New Reverse Zone'}>
      <div className="space-y-4">
        {error && (
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
            <AlertCircle className="w-4 h-4 shrink-0" /> {error}
          </div>
        )}
        {kind === 'forward' ? (
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Domain name</label>
            <input className="input-field font-mono" placeholder="e.g. soteria.local" value={domain} onChange={(e) => setDomain(e.target.value)} autoFocus />
          </div>
        ) : (
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Network (IPv4 CIDR)</label>
            <input className="input-field font-mono" placeholder="e.g. 192.168.2.0/24" value={cidr} onChange={(e) => setCidr(e.target.value)} autoFocus />
            <p className="text-xs mt-1.5" style={{ color: 'var(--s-muted)' }}>
              Reverse zone: {reverseName ? <span className="font-mono heading">{reverseName}</span> : 'enter a /8, /16 or /24 network'}
            </p>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={create} disabled={saving} className="btn-primary flex items-center gap-2">
            {saving && <Loader2 className="w-4 h-4 animate-spin" />} Create zone
          </button>
        </div>
      </div>
    </Modal>
  );
}
