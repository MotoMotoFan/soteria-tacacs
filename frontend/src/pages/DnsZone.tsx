import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Plus, Pencil, Loader2, Search, X, ListOrdered, DatabaseZap, AlertCircle } from 'lucide-react';
import { api, type DnsZone as DnsZoneT, type DnsRecord } from '../lib/api';
import ColumnFilterHeader from '../components/ColumnFilterHeader';
import Modal from '../components/Modal';

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'NS', 'MX', 'PTR', 'SRV'];
const PAGE_SIZE = 50;

const pad = (s: string, w: number) => (s.length < w ? s + ' '.repeat(w - s.length) : s);

function renderZoneFile(zone: DnsZoneT | null, records: DnsRecord[]): string {
  if (!zone) return '';
  const hasTTL = records.some((r) => r.ttl);
  const nameW = Math.max(1, ...records.map((r) => (r.name || '@').length));
  const typeW = Math.max(1, ...records.map((r) => r.type.length));
  const ttlW = hasTTL ? Math.max(1, ...records.map((r) => (r.ttl ? String(r.ttl) : '').length)) : 0;

  const lines = [
    `$TTL ${zone.ttl}`,
    `@       IN  SOA ${zone.primaryNs} ${zone.admin} (`,
    `                ${zone.serial} ; Serial (managed by soteria-agent)`,
    `                3600       ; Refresh`,
    `                1800       ; Retry`,
    `                604800     ; Expire`,
    `                300 )      ; Negative cache TTL`,
    '',
  ];
  for (const r of records) {
    const ttl = hasTTL ? pad(r.ttl ? String(r.ttl) : '', ttlW) + '  ' : '';
    lines.push(`${pad(r.name || '@', nameW)}  ${ttl}IN  ${pad(r.type, typeW)}  ${r.value}`);
  }
  return lines.join('\n');
}

export default function DnsZone() {
  const { name = '' } = useParams();
  const [zone, setZone] = useState<DnsZoneT | null>(null);
  const [records, setRecords] = useState<DnsRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Add / edit form
  const [form, setForm] = useState<DnsRecord>({ name: '', type: 'A', value: '' });
  const [editIndex, setEditIndex] = useState<number | null>(null);

  // Left-list filters
  const [search, setSearch] = useState('');
  const [filterName, setFilterName] = useState<string[]>([]);
  const [colSearchName, setColSearchName] = useState('');
  const [filterType, setFilterType] = useState<string[]>([]);
  const [colSearchType, setColSearchType] = useState('');
  const [filterValue, setFilterValue] = useState<string[]>([]);
  const [colSearchValue, setColSearchValue] = useState('');
  const [page, setPage] = useState(0);
  // View sort (A-Z on a column). The raw-file preview follows it; it is only
  // written to the file when "Apply order" is clicked (otherwise the stored
  // order stays the add sequence).
  const [sort, setSort] = useState<{ key: 'name' | 'type' | 'value'; dir: 'asc' | 'desc' } | null>(null);
  const [showScan, setShowScan] = useState(false);

  const isReverse = zone?.kind === 'reverse';

  const load = async () => {
    setLoading(true);
    try {
      const z = await api.getDnsZone(name);
      setZone(z);
      setRecords(z.records ?? []);
      setForm((f) => ({ ...f, type: z.kind === 'reverse' ? 'PTR' : 'A' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [name]);
  useEffect(() => { setPage(0); }, [search, filterName, colSearchName, filterType, colSearchType, filterValue, colSearchValue, sort]);

  const toggleSort = (key: 'name' | 'type' | 'value') =>
    setSort((s) => (s && s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  const toggleFilter = (setter: Dispatch<SetStateAction<string[]>>, v: string) =>
    setter((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]));

  // A record matches the column filters (excludeColumn is left out so a column's
  // own options stay contextual to the other filters).
  const colMatch = (r: DnsRecord, exclude: string) =>
    (exclude === 'name' || ((filterName.length === 0 || filterName.includes(r.name)) && (colSearchName === '' || r.name.toLowerCase().includes(colSearchName.toLowerCase())))) &&
    (exclude === 'type' || ((filterType.length === 0 || filterType.includes(r.type)) && (colSearchType === '' || r.type.toLowerCase().includes(colSearchType.toLowerCase())))) &&
    (exclude === 'value' || ((filterValue.length === 0 || filterValue.includes(r.value)) && (colSearchValue === '' || r.value.toLowerCase().includes(colSearchValue.toLowerCase()))));

  // Reverse convenience: a full in-zone IPv4 owner -> its host octet.
  const normalize = (r: DnsRecord): DnsRecord => {
    const n = r.name.trim();
    if (isReverse && /^\d+\.\d+\.\d+\.\d+$/.test(n)) return { ...r, name: n.split('.').pop()!, value: r.value.trim() };
    return { ...r, name: n, value: r.value.trim() };
  };

  const persist = async (next: DnsRecord[]) => {
    setSaving(true);
    setError(null);
    try {
      const cleaned = next.map(normalize);
      await api.saveDnsRecords(name, cleaned);
      const z = await api.getDnsZone(name); // refresh serial + canonical form
      setZone(z);
      setRecords(z.records ?? []);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const submit = async () => {
    if (!form.name.trim() || !form.value.trim()) { setError('Name and value are required.'); return; }
    const next = editIndex != null
      ? records.map((r, i) => (i === editIndex ? form : r))
      : [...records, form];
    const ok = await persist(next);
    if (ok) { setForm({ name: '', type: isReverse ? 'PTR' : 'A', value: '' }); setEditIndex(null); }
  };

  const startEdit = (idx: number) => { setForm(records[idx]); setEditIndex(idx); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const removeRow = async (idx: number) => {
    if (!window.confirm('Delete this record?')) return;
    await persist(records.filter((_, i) => i !== idx));
    if (editIndex === idx) { setEditIndex(null); setForm({ name: '', type: isReverse ? 'PTR' : 'A', value: '' }); }
  };

  const ctxNames = useMemo(() => [...new Set(records.filter((r) => colMatch(r, 'name')).map((r) => r.name))].sort(),
    [records, filterType, colSearchType, filterValue, colSearchValue]); // eslint-disable-line
  const ctxTypes = useMemo(() => [...new Set(records.filter((r) => colMatch(r, 'type')).map((r) => r.type))].sort(),
    [records, filterName, colSearchName, filterValue, colSearchValue]); // eslint-disable-line
  const ctxValues = useMemo(() => [...new Set(records.filter((r) => colMatch(r, 'value')).map((r) => r.value))].sort(),
    [records, filterName, colSearchName, filterType, colSearchType]); // eslint-disable-line

  // Sorted (numeric-aware, so 192.168.1.9 < 192.168.1.10), keeping each
  // record's original index so edit/delete still target the right record.
  const ordered = useMemo(() => {
    const indexed = records.map((r, idx) => ({ r, idx }));
    if (!sort) return indexed;
    const val = (x: { r: DnsRecord }) => (sort.key === 'name' ? x.r.name : sort.key === 'type' ? x.r.type : x.r.value);
    const s = [...indexed].sort((a, b) => val(a).localeCompare(val(b), undefined, { numeric: true, sensitivity: 'base' }));
    return sort.dir === 'asc' ? s : s.reverse();
  }, [records, sort]);

  const rawRecords = useMemo(() => ordered.map((x) => x.r), [ordered]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return ordered.filter(({ r }) =>
      (q === '' || `${r.name} ${r.type} ${r.value}`.toLowerCase().includes(q)) && colMatch(r, ''));
  }, [ordered, search, filterName, colSearchName, filterType, colSearchType, filterValue, colSearchValue]); // eslint-disable-line

  const applyOrder = async () => {
    if (!sort) return;
    if (await persist(rawRecords)) setSort(null); // stored order is now the sorted order
  };

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const backTo = isReverse ? '/dns/reverse' : '/dns/domains';

  if (loading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-brand-magenta" /></div>;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link to={backTo} className="inline-flex items-center gap-1.5 text-sm mb-1" style={{ color: 'var(--s-muted)' }}>
            <ArrowLeft className="w-4 h-4" /> {isReverse ? 'Reverse Zones' : 'Authoritative Domains'}
          </Link>
          <h1 className="text-2xl font-bold heading font-mono flex items-center gap-2">
            {name}
            <span className={isReverse ? 'badge-warning' : 'badge-success'}>{isReverse ? 'reverse' : 'forward'}</span>
          </h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--s-muted)' }}>
            {records.length} records · serial {zone?.serial} {saving && '· saving…'}
          </p>
        </div>
        <button onClick={() => setShowScan(true)} className="btn-secondary flex items-center gap-2 shrink-0">
          <DatabaseZap className="w-4 h-4" /> Scan from NetBox
        </button>
      </div>

      {error && (
        <div className="glass-card p-4 border-l-2 border-red-500">
          <pre className="text-sm text-red-400 whitespace-pre-wrap">{error}</pre>
        </div>
      )}

      {/* Division 1: add / edit an entry */}
      <div className="glass-card p-4">
        <h3 className="text-sm font-semibold heading mb-3">{editIndex != null ? 'Edit entry' : 'Add entry'}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end">
          <div className="sm:col-span-3">
            <label className="block text-xs mb-1" style={{ color: 'var(--s-muted)' }}>Name</label>
            <input className="input-field font-mono text-sm" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={isReverse ? '160 or 192.168.1.160' : 'www or @'} />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs mb-1" style={{ color: 'var(--s-muted)' }}>Type</label>
            <select className="select-field text-sm" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {RECORD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="sm:col-span-4">
            <label className="block text-xs mb-1" style={{ color: 'var(--s-muted)' }}>Value</label>
            <input className="input-field font-mono text-sm" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} placeholder={isReverse ? 'host.soteria.local.' : '192.168.1.10'} />
          </div>
          <div className="sm:col-span-1">
            <label className="block text-xs mb-1" style={{ color: 'var(--s-muted)' }}>TTL</label>
            <input type="number" className="input-field font-mono text-sm" value={form.ttl ?? ''} onChange={(e) => setForm({ ...form, ttl: e.target.value ? +e.target.value : undefined })} placeholder="-" />
          </div>
          <div className="sm:col-span-2 flex gap-2">
            <button onClick={submit} disabled={saving} className="btn-primary flex-1 flex items-center justify-center gap-1.5 text-sm">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} {editIndex != null ? 'Update' : 'Add'}
            </button>
            {editIndex != null && (
              <button onClick={() => { setEditIndex(null); setForm({ name: '', type: isReverse ? 'PTR' : 'A', value: '' }); }} className="btn-ghost text-sm px-2">Cancel</button>
            )}
          </div>
        </div>
        <p className="text-xs mt-2" style={{ color: 'var(--s-muted)' }}>
          {isReverse
            ? 'PTR: enter the host octet or a full in-zone IP; value is the target FQDN (trailing dot).'
            : 'Owner is relative to the zone ("@" = apex). CNAME/NS/MX values are FQDNs with a trailing dot.'}
        </p>
      </div>

      {/* Division 2: list (left) + raw file (right) */}
      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-4">
        {/* Left: filterable, paginated records */}
        <div className="glass-card overflow-hidden">
          <div className="p-3 flex items-center gap-2" style={{ borderBottom: '1px solid var(--s-border)' }}>
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--s-muted)' }} />
              <input className="input-field pl-9 text-sm" placeholder="Search records…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <span className="text-xs shrink-0" style={{ color: 'var(--s-muted)' }}>{filtered.length} of {records.length}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px]">
              <thead>
                <tr>
                  <ColumnFilterHeader
                    label="Name" options={ctxNames} selected={filterName}
                    onToggle={(v) => toggleFilter(setFilterName, v)} onClear={() => setFilterName([])}
                    colSearch={colSearchName} onColSearchChange={setColSearchName}
                    sortDir={sort?.key === 'name' ? sort.dir : null} onSort={() => toggleSort('name')}
                  />
                  <ColumnFilterHeader
                    label="Type" options={ctxTypes} selected={filterType} className="w-24"
                    onToggle={(v) => toggleFilter(setFilterType, v)} onClear={() => setFilterType([])}
                    colSearch={colSearchType} onColSearchChange={setColSearchType}
                    sortDir={sort?.key === 'type' ? sort.dir : null} onSort={() => toggleSort('type')}
                  />
                  <ColumnFilterHeader
                    label="Value" options={ctxValues} selected={filterValue}
                    onToggle={(v) => toggleFilter(setFilterValue, v)} onClear={() => setFilterValue([])}
                    colSearch={colSearchValue} onColSearchChange={setColSearchValue}
                    sortDir={sort?.key === 'value' ? sort.dir : null} onSort={() => toggleSort('value')}
                  />
                  <th className="table-header w-16">TTL</th>
                  <th className="table-header w-16"></th>
                </tr>
              </thead>
              <tbody>
                {pageRows.length === 0 && (
                  <tr><td className="table-cell" colSpan={5} style={{ color: 'var(--s-muted)' }}>No records match.</td></tr>
                )}
                {pageRows.map(({ r, idx }) => (
                  <tr key={idx} className={`table-row ${editIndex === idx ? 'bg-brand-purple/10' : ''}`}>
                    <td className="table-cell font-mono text-sm">{r.name}</td>
                    <td className="table-cell"><span className="badge-readonly font-mono text-[10px]">{r.type}</span></td>
                    <td className="table-cell font-mono text-sm break-all">{r.value}</td>
                    <td className="table-cell font-mono text-xs" style={{ color: 'var(--s-muted)' }}>{r.ttl ?? '-'}</td>
                    <td className="table-cell text-right">
                      <div className="flex items-center justify-end gap-0.5">
                        <button onClick={() => startEdit(idx)} className="btn-ghost p-1" title="Edit"><Pencil className="w-3.5 h-3.5" /></button>
                        <button onClick={() => removeRow(idx)} className="btn-ghost p-1 hover:text-red-400" title="Delete"><X className="w-3.5 h-3.5" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pageCount > 1 && (
            <div className="p-3 flex items-center justify-between text-sm" style={{ borderTop: '1px solid var(--s-border)' }}>
              <span style={{ color: 'var(--s-muted)' }}>
                {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
              </span>
              <div className="flex items-center gap-2">
                <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="btn-ghost text-xs px-2 py-1 disabled:opacity-30">Prev</button>
                <span className="text-xs" style={{ color: 'var(--s-muted)' }}>{page + 1} / {pageCount}</span>
                <button disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)} className="btn-ghost text-xs px-2 py-1 disabled:opacity-30">Next</button>
              </div>
            </div>
          )}
        </div>

        {/* Right: raw zone file (scrollable) */}
        <div className="glass-card overflow-hidden flex flex-col">
          <div className="px-4 py-3 shrink-0 flex items-center justify-between gap-2" style={{ borderBottom: '1px solid var(--s-border)' }}>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold heading">Zone file</h3>
              <p className="text-xs truncate" style={{ color: 'var(--s-muted)' }}>
                {sort ? 'sorted preview (not saved yet)' : `db.${name}`}
              </p>
            </div>
            <button
              onClick={applyOrder}
              disabled={!sort || saving}
              title={sort ? 'Write the current sort order into the zone file' : 'Sort a column first'}
              className="btn-secondary text-xs flex items-center gap-1.5 shrink-0 disabled:opacity-40"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ListOrdered className="w-3.5 h-3.5" />} Apply order
            </button>
          </div>
          <pre className="config-preview m-0 rounded-none border-0 whitespace-pre overflow-auto flex-1" style={{ maxHeight: '70vh' }}>
            {renderZoneFile(zone, rawRecords)}
          </pre>
        </div>
      </div>

      <ScanZoneModal
        open={showScan}
        zoneName={name}
        isReverse={!!isReverse}
        onClose={() => setShowScan(false)}
        onDone={() => void load()}
      />
    </div>
  );
}

function ScanZoneModal({ open, zoneName, isReverse, onClose, onDone }: {
  open: boolean; zoneName: string; isReverse: boolean; onClose: () => void; onDone: () => void;
}) {
  const [tag, setTag] = useState('dns-entry');
  const [domain, setDomain] = useState('soteria.local');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ dryRun: boolean; added: DnsRecord[]; updated: DnsRecord[]; skipped: number } | null>(null);
  const [applied, setApplied] = useState(false);

  useEffect(() => { if (open) { setTag('dns-entry'); setDomain('soteria.local'); setError(null); setPlan(null); setApplied(false); } }, [open]);
  const resetPlan = () => { setPlan(null); setApplied(false); };

  const run = async (dryRun: boolean) => {
    setBusy(true); setError(null);
    try {
      const res = await api.syncZoneFromSot(zoneName, tag.trim(), domain.trim(), dryRun);
      setPlan(res);
      setApplied(!dryRun);
      if (!dryRun) onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const total = plan ? plan.added.length + plan.updated.length : 0;
  const showPreview = !plan || applied;
  const rows = plan ? [...plan.added.map((r) => ({ r, mark: '+' })), ...plan.updated.map((r) => ({ r, mark: '~' }))] : [];

  return (
    <Modal open={open} onClose={onClose} title="Scan from NetBox">
      <div className="space-y-4">
        <p className="text-sm" style={{ color: 'var(--s-muted)' }}>
          {isReverse
            ? 'Previews PTR records for IPs in this zone’s network from NetBox. Nothing is written until you Apply; existing records are kept.'
            : 'Previews A/AAAA records from NetBox prefixes with the tag. Nothing is written until you Apply; existing records are kept.'}
        </p>
        {error && (
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
            <AlertCircle className="w-4 h-4 shrink-0" /> {error}
          </div>
        )}
        {!isReverse && (
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Prefix tag</label>
            <input className="input-field font-mono" value={tag} onChange={(e) => { setTag(e.target.value); resetPlan(); }} placeholder="dns-entry" />
          </div>
        )}
        {isReverse && (
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Domain suffix</label>
            <input className="input-field font-mono" value={domain} onChange={(e) => { setDomain(e.target.value); resetPlan(); }} placeholder="soteria.local" />
            <p className="text-xs mt-1.5" style={{ color: 'var(--s-muted)' }}>Appended to bare device names to build the PTR target FQDN (ignored when NetBox already has a full dns_name).</p>
          </div>
        )}
        {plan && (
          <div className="rounded-lg p-3 text-sm space-y-2" style={{ backgroundColor: 'var(--s-bg)', border: '1px solid var(--s-border)', color: 'var(--s-text)' }}>
            <p>
              {applied ? 'Applied' : 'Will apply'}: <span className="text-emerald-400">{plan.added.length} new</span>, <span className="text-amber-400">{plan.updated.length} changed</span>
              {plan.skipped > 0 && <>, {plan.skipped} skipped (invalid names)</>}.
            </p>
            {rows.length > 0 && (
              <pre className="config-preview whitespace-pre overflow-auto" style={{ maxHeight: '30vh' }}>
                {rows.slice(0, 200).map(({ r, mark }) => `${mark} ${r.name}  IN  ${r.type}  ${r.value}`).join('\n')}
                {rows.length > 200 ? `\n… +${rows.length - 200} more` : ''}
              </pre>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="btn-secondary">Close</button>
          {showPreview ? (
            <button onClick={() => run(true)} disabled={busy} className="btn-primary flex items-center gap-2">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <DatabaseZap className="w-4 h-4" />} Preview
            </button>
          ) : (
            <button onClick={() => run(false)} disabled={busy || total === 0} className="btn-primary flex items-center gap-2">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <DatabaseZap className="w-4 h-4" />} Apply — {total} change{total === 1 ? '' : 's'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
