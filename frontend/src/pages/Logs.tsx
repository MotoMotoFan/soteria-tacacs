import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Search, Filter, Download, CheckCircle, XCircle, AlertCircle, X, ChevronDown, RefreshCw } from 'lucide-react';
import { api, type LogEntry } from '../lib/api';
import { useApi, LoadState } from '../lib/useApi';

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// Local "YYYY-MM-DDTHH:MM:SS" for <input type="datetime-local" step="1">.
function localDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// A datetime-local value may omit seconds; normalize so comparisons align
// with the agent's "YYYY-MM-DD HH:MM:SS" timestamps (space, not T).
function toComparable(dt: string): string {
  const v = dt.length === 16 ? `${dt}:00` : dt; // add seconds if missing
  return v.replace('T', ' ');
}

const typeColors: Record<string, string> = {
  authentication: 'bg-brand-purple/15 text-brand-magenta border-brand-purple/20',
  authorization: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  accounting: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
};

const resultIcons: Record<string, React.ElementType> = {
  success: CheckCircle, failure: XCircle, error: AlertCircle,
};

const resultColors: Record<string, string> = {
  success: 'text-emerald-400', failure: 'text-red-400', error: 'text-amber-400',
};

export default function Logs() {
  // Full datetime range (date + hh:mm:ss). Defaults to the whole of today.
  const [fromDT, setFromDT] = useState(`${todayISO()}T00:00:00`);
  const [toDT, setToDT] = useState(`${todayISO()}T23:59:59`);
  // The agent fetches by day; time-of-day is filtered client-side below.
  const fromDate = fromDT.slice(0, 10);
  const toDate = toDT.slice(0, 10);
  const { data, loading, error, reload } = useApi(() => api.getLogs(fromDate, toDate), [fromDate, toDate]);
  const logs = data ?? [];
  const [exportOpen, setExportOpen] = useState(false);

  const fromCmp = toComparable(fromDT);
  const toCmp = toComparable(toDT);
  const inTimeRange = (log: LogEntry) => log.timestamp >= fromCmp && log.timestamp <= toCmp;

  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<string[]>([]);
  const [filterResult, setFilterResult] = useState<string[]>([]);
  const [filterUser, setFilterUser] = useState<string[]>([]);
  const [filterDevice, setFilterDevice] = useState<string[]>([]);
  const [filterDeviceIp, setFilterDeviceIp] = useState<string[]>([]);
  const [filterPort, setFilterPort] = useState<string[]>([]);
  const [filterService, setFilterService] = useState<string[]>([]);
  const [filterCommand, setFilterCommand] = useState<string[]>([]);

  // Column search strings - filter table live while typing
  const [colSearchType, setColSearchType] = useState('');
  const [colSearchUser, setColSearchUser] = useState('');
  const [colSearchDevice, setColSearchDevice] = useState('');
  const [colSearchDeviceIp, setColSearchDeviceIp] = useState('');
  const [colSearchResult, setColSearchResult] = useState('');
  const [colSearchPort, setColSearchPort] = useState('');
  const [colSearchService, setColSearchService] = useState('');
  const [colSearchCommand, setColSearchCommand] = useState('');

  const hasFilters = filterType.length > 0 || filterResult.length > 0 || filterUser.length > 0 || filterDevice.length > 0 || filterDeviceIp.length > 0 || filterPort.length > 0 || filterService.length > 0 || filterCommand.length > 0 || search !== '' || colSearchType !== '' || colSearchUser !== '' || colSearchDevice !== '' || colSearchDeviceIp !== '' || colSearchResult !== '' || colSearchPort !== '' || colSearchService !== '' || colSearchCommand !== '';

  // Column accessors (port/service/command are optional on LogEntry).
  const colVal = (log: LogEntry, col: string): string => {
    switch (col) {
      case 'port': return log.port ?? '';
      case 'service': return log.service ?? '';
      case 'command': return log.command ?? '';
      default: return '';
    }
  };
  const matchCol = (log: LogEntry, col: string, sel: string[], colSearch: string) => {
    const v = colVal(log, col);
    return (sel.length === 0 || sel.includes(v)) && (colSearch === '' || v.toLowerCase().includes(colSearch.toLowerCase()));
  };

  const matchesText = (log: LogEntry, q: string) => {
    const s = q.toLowerCase();
    return log.user.toLowerCase().includes(s) ||
      log.device.toLowerCase().includes(s) ||
      log.deviceIp.includes(q) ||
      (log.command ?? '').toLowerCase().includes(s) ||
      (log.service ?? '').toLowerCase().includes(s) ||
      (log.port ?? '').toLowerCase().includes(s) ||
      log.detail.toLowerCase().includes(s);
  };

  const filtered = logs.filter(log => {
    if (!inTimeRange(log)) return false;
    const matchSearch = search === '' || matchesText(log, search);
    const matchType = (filterType.length === 0 || filterType.includes(log.type)) &&
      (colSearchType === '' || log.type.toLowerCase().includes(colSearchType.toLowerCase()));
    const matchResult = (filterResult.length === 0 || filterResult.includes(log.result)) &&
      (colSearchResult === '' || log.result.toLowerCase().includes(colSearchResult.toLowerCase()));
    const matchUser = (filterUser.length === 0 || filterUser.includes(log.user)) &&
      (colSearchUser === '' || log.user.toLowerCase().includes(colSearchUser.toLowerCase()));
    const matchDevice = (filterDevice.length === 0 || filterDevice.includes(log.device)) &&
      (colSearchDevice === '' || log.device.toLowerCase().includes(colSearchDevice.toLowerCase()));
    const matchDeviceIp = (filterDeviceIp.length === 0 || filterDeviceIp.includes(log.deviceIp)) &&
      (colSearchDeviceIp === '' || log.deviceIp.includes(colSearchDeviceIp));
    const matchPort = matchCol(log, 'port', filterPort, colSearchPort);
    const matchService = matchCol(log, 'service', filterService, colSearchService);
    const matchCommand = matchCol(log, 'command', filterCommand, colSearchCommand);
    return matchSearch && matchType && matchResult && matchUser && matchDevice && matchDeviceIp && matchPort && matchService && matchCommand;
  });

  // Pagination (client-side over the filtered set)
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paged = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  // Reset to page 1 whenever the filtered set's controls change.
  const filterSig = JSON.stringify([
    search, fromDT, toDT, pageSize, filterType, filterUser, filterDevice, filterDeviceIp,
    filterResult, filterPort, filterService, filterCommand, colSearchType, colSearchUser,
    colSearchDevice, colSearchDeviceIp, colSearchResult, colSearchPort, colSearchService, colSearchCommand,
  ]);
  useEffect(() => { setPage(1); }, [filterSig]);

  const clearAll = () => {
    setSearch(''); setFilterType([]); setFilterResult([]); setFilterUser([]); setFilterDevice([]); setFilterDeviceIp([]);
    setFilterPort([]); setFilterService([]); setFilterCommand([]);
    setColSearchType(''); setColSearchUser(''); setColSearchDevice(''); setColSearchDeviceIp(''); setColSearchResult('');
    setColSearchPort(''); setColSearchService(''); setColSearchCommand('');
  };

  const toggleFilter = (setter: React.Dispatch<React.SetStateAction<string[]>>, value: string) => {
    setter(prev => prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value]);
  };

  // Contextual options: filter options based on what other columns have selected
  // Each column sees options from rows that pass ALL other filters (excluding its own)
  const baseFilter = (log: LogEntry, excludeColumn: string) => {
    if (!inTimeRange(log)) return false;
    const matchSearch = search === '' || matchesText(log, search);
    const matchType = excludeColumn === 'type' || ((filterType.length === 0 || filterType.includes(log.type)) && (colSearchType === '' || log.type.toLowerCase().includes(colSearchType.toLowerCase())));
    const matchResult = excludeColumn === 'result' || ((filterResult.length === 0 || filterResult.includes(log.result)) && (colSearchResult === '' || log.result.toLowerCase().includes(colSearchResult.toLowerCase())));
    const matchUser = excludeColumn === 'user' || ((filterUser.length === 0 || filterUser.includes(log.user)) && (colSearchUser === '' || log.user.toLowerCase().includes(colSearchUser.toLowerCase())));
    const matchDevice = excludeColumn === 'device' || ((filterDevice.length === 0 || filterDevice.includes(log.device)) && (colSearchDevice === '' || log.device.toLowerCase().includes(colSearchDevice.toLowerCase())));
    const matchDeviceIp = excludeColumn === 'deviceIp' || ((filterDeviceIp.length === 0 || filterDeviceIp.includes(log.deviceIp)) && (colSearchDeviceIp === '' || log.deviceIp.includes(colSearchDeviceIp)));
    const matchPort = excludeColumn === 'port' || matchCol(log, 'port', filterPort, colSearchPort);
    const matchService = excludeColumn === 'service' || matchCol(log, 'service', filterService, colSearchService);
    const matchCommand = excludeColumn === 'command' || matchCol(log, 'command', filterCommand, colSearchCommand);
    return matchSearch && matchType && matchResult && matchUser && matchDevice && matchDeviceIp && matchPort && matchService && matchCommand;
  };

  const ctxTypes = [...new Set(logs.filter(l => baseFilter(l, 'type')).map(l => l.type))].sort();
  const ctxUsers = [...new Set(logs.filter(l => baseFilter(l, 'user')).map(l => l.user))].sort();
  const ctxDevices = [...new Set(logs.filter(l => baseFilter(l, 'device')).map(l => l.device))].sort();
  const ctxDeviceIps = [...new Set(logs.filter(l => baseFilter(l, 'deviceIp')).map(l => l.deviceIp))].sort();
  const ctxResults = [...new Set(logs.filter(l => baseFilter(l, 'result')).map(l => l.result))].sort();
  const ctxPorts = [...new Set(logs.filter(l => baseFilter(l, 'port')).map(l => l.port ?? '').filter(Boolean))].sort();
  const ctxServices = [...new Set(logs.filter(l => baseFilter(l, 'service')).map(l => l.service ?? '').filter(Boolean))].sort();
  const ctxCommands = [...new Set(logs.filter(l => baseFilter(l, 'command')).map(l => l.command ?? '').filter(Boolean))].sort();

  const exportCsv = (rows: LogEntry[], scope: string) => {
    const cols: [string, (l: LogEntry) => string][] = [
      ['Timestamp', l => l.timestamp],
      ['Type', l => l.type],
      ['User', l => l.user],
      ['Device', l => l.device],
      ['Device IP', l => l.deviceIp],
      ['Port', l => l.port ?? ''],
      ['Result', l => l.result],
      ['Service', l => l.service ?? ''],
      ['Command', l => l.command ?? ''],
      ['Info', l => l.detail],
    ];
    const esc = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const lines = [
      cols.map(c => c[0]).join(','),
      ...rows.map(l => cols.map(c => esc(c[1](l))).join(',')),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = (s: string) => s.replace('T', '_').replace(/:/g, '');
    a.download = `soteria-logs-${stamp(fromDT)}_to_${stamp(toDT)}-${scope}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const pager = (edge: 'top' | 'bottom') => filtered.length === 0 ? null : (
    <div
      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
      style={edge === 'top' ? { borderBottom: '1px solid var(--s-border)' } : { borderTop: '1px solid var(--s-border)' }}
    >
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--s-muted)' }}>
        <span>{(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, filtered.length)} of {filtered.length}</span>
        <span className="mx-1">·</span>
        <span>Rows</span>
        <select className="select-field text-xs py-1 w-20" value={pageSize} onChange={e => setPageSize(parseInt(e.target.value, 10))}>
          {[25, 50, 100, 200].map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div className="flex items-center gap-1">
        <button onClick={() => setPage(1)} disabled={currentPage === 1} className="btn-ghost text-xs py-1 px-2 disabled:opacity-30">« First</button>
        <button onClick={() => setPage(currentPage - 1)} disabled={currentPage === 1} className="btn-ghost text-xs py-1 px-2 disabled:opacity-30">‹ Prev</button>
        <span className="text-xs px-2" style={{ color: 'var(--s-text)' }}>Page {currentPage} / {totalPages}</span>
        <button onClick={() => setPage(currentPage + 1)} disabled={currentPage >= totalPages} className="btn-ghost text-xs py-1 px-2 disabled:opacity-30">Next ›</button>
        <button onClick={() => setPage(totalPages)} disabled={currentPage >= totalPages} className="btn-ghost text-xs py-1 px-2 disabled:opacity-30">Last »</button>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold heading">AAA Logs</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--s-muted)' }}>Authentication, Authorization & Accounting events</p>
        </div>
        <div className="relative">
          <button
            onClick={() => setExportOpen(o => !o)}
            disabled={filtered.length === 0}
            className="btn-secondary flex items-center gap-2 disabled:opacity-40"
            title={filtered.length === 0 ? 'Nothing to export' : 'Export as CSV'}
          >
            <Download className="w-4 h-4" /> Export <ChevronDown className="w-3.5 h-3.5" />
          </button>
          {exportOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setExportOpen(false)} />
              <div className="absolute right-0 top-11 z-50 w-56 rounded-lg shadow-2xl py-1" style={{ backgroundColor: 'var(--s-surface)', border: '1px solid var(--s-border)' }}>
                <button
                  onClick={() => { setExportOpen(false); exportCsv(paged, 'page'); }}
                  className="w-full px-3 py-2 text-left text-sm"
                  style={{ color: 'var(--s-text)' }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--s-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                >
                  Current page <span style={{ color: 'var(--s-muted)' }}>({paged.length})</span>
                </button>
                <button
                  onClick={() => { setExportOpen(false); exportCsv(filtered, 'all'); }}
                  className="w-full px-3 py-2 text-left text-sm"
                  style={{ color: 'var(--s-text)' }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--s-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                >
                  All filtered rows <span style={{ color: 'var(--s-muted)' }}>({filtered.length})</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--s-muted)' }} />
          <input type="text" placeholder="Search user, device, IP, detail..." value={search} onChange={e => setSearch(e.target.value)} className="input-field pl-10" />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: 'var(--s-muted)' }}>From</span>
          <input
            type="datetime-local"
            step="1"
            value={fromDT}
            max={toDT}
            onChange={e => setFromDT(e.target.value || `${todayISO()}T00:00:00`)}
            className="input-field w-52"
          />
          <span className="text-xs" style={{ color: 'var(--s-muted)' }}>to</span>
          <input
            type="datetime-local"
            step="1"
            value={toDT}
            min={fromDT}
            max={localDateTime(new Date())}
            onChange={e => setToDT(e.target.value || `${todayISO()}T23:59:59`)}
            className="input-field w-52"
          />
        </div>
        <button onClick={reload} className="btn-secondary flex items-center gap-2 text-sm" title="Refresh">
          <RefreshCw className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--s-muted)' }}>
          <Filter className="w-4 h-4" />
          <span>{filtered.length}/{logs.length}</span>
        </div>
      </div>

      {hasFilters && (
        <div className="flex flex-wrap items-center gap-2">
          {filterUser.map(u => <FilterChip key={`u-${u}`} label={`User: ${u}`} onClear={() => toggleFilter(setFilterUser, u)} />)}
          {filterDevice.map(d => <FilterChip key={`d-${d}`} label={`Device: ${d}`} onClear={() => toggleFilter(setFilterDevice, d)} />)}
          {filterDeviceIp.map(d => <FilterChip key={`di-${d}`} label={`IP: ${d}`} onClear={() => toggleFilter(setFilterDeviceIp, d)} />)}
          {filterType.map(t => <FilterChip key={`t-${t}`} label={`Type: ${t}`} onClear={() => toggleFilter(setFilterType, t)} />)}
          {filterResult.map(r => <FilterChip key={`r-${r}`} label={`Result: ${r}`} onClear={() => toggleFilter(setFilterResult, r)} />)}
          {filterPort.map(p => <FilterChip key={`p-${p}`} label={`Port: ${p}`} onClear={() => toggleFilter(setFilterPort, p)} />)}
          {filterService.map(s => <FilterChip key={`s-${s}`} label={`Service: ${s}`} onClear={() => toggleFilter(setFilterService, s)} />)}
          {filterCommand.map(c => <FilterChip key={`c-${c}`} label={`Command: ${c}`} onClear={() => toggleFilter(setFilterCommand, c)} />)}
          {colSearchUser && <FilterChip label={`User ~"${colSearchUser}"`} onClear={() => setColSearchUser('')} />}
          {colSearchDevice && <FilterChip label={`Device ~"${colSearchDevice}"`} onClear={() => setColSearchDevice('')} />}
          {colSearchDeviceIp && <FilterChip label={`IP ~"${colSearchDeviceIp}"`} onClear={() => setColSearchDeviceIp('')} />}
          {colSearchType && <FilterChip label={`Type ~"${colSearchType}"`} onClear={() => setColSearchType('')} />}
          {colSearchResult && <FilterChip label={`Result ~"${colSearchResult}"`} onClear={() => setColSearchResult('')} />}
          {colSearchPort && <FilterChip label={`Port ~"${colSearchPort}"`} onClear={() => setColSearchPort('')} />}
          {colSearchService && <FilterChip label={`Service ~"${colSearchService}"`} onClear={() => setColSearchService('')} />}
          {colSearchCommand && <FilterChip label={`Command ~"${colSearchCommand}"`} onClear={() => setColSearchCommand('')} />}
          {search !== '' && <FilterChip label={`Search: "${search}"`} onClear={() => setSearch('')} />}
          <button onClick={clearAll} className="text-xs text-brand-magenta hover:text-brand-pink transition-colors ml-1">Clear all</button>
        </div>
      )}

      {/* Table wrapper - no overflow:hidden so dropdowns aren't clipped */}
      <LoadState loading={loading} error={error} onRetry={reload}>
      <div className="glass-card">
        {pager('top')}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px]">
            <thead>
              <tr style={{ backgroundColor: 'var(--s-bg)' }}>
                <th className="table-header">Timestamp</th>
                <ColumnFilterHeader label="Type" options={ctxTypes} selected={filterType} onToggle={(v) => toggleFilter(setFilterType, v)} onClear={() => setFilterType([])} colSearch={colSearchType} onColSearchChange={setColSearchType} />
                <ColumnFilterHeader label="User" options={ctxUsers} selected={filterUser} onToggle={(v) => toggleFilter(setFilterUser, v)} onClear={() => setFilterUser([])} colSearch={colSearchUser} onColSearchChange={setColSearchUser} />
                <ColumnFilterHeader label="Device" options={ctxDevices} selected={filterDevice} onToggle={(v) => toggleFilter(setFilterDevice, v)} onClear={() => setFilterDevice([])} colSearch={colSearchDevice} onColSearchChange={setColSearchDevice} />
                <ColumnFilterHeader label="Device IP" options={ctxDeviceIps} selected={filterDeviceIp} onToggle={(v) => toggleFilter(setFilterDeviceIp, v)} onClear={() => setFilterDeviceIp([])} colSearch={colSearchDeviceIp} onColSearchChange={setColSearchDeviceIp} />
                <ColumnFilterHeader label="Port" options={ctxPorts} selected={filterPort} onToggle={(v) => toggleFilter(setFilterPort, v)} onClear={() => setFilterPort([])} colSearch={colSearchPort} onColSearchChange={setColSearchPort} />
                <ColumnFilterHeader label="Result" options={ctxResults} selected={filterResult} onToggle={(v) => toggleFilter(setFilterResult, v)} onClear={() => setFilterResult([])} colSearch={colSearchResult} onColSearchChange={setColSearchResult} />
                <ColumnFilterHeader label="Service" options={ctxServices} selected={filterService} onToggle={(v) => toggleFilter(setFilterService, v)} onClear={() => setFilterService([])} colSearch={colSearchService} onColSearchChange={setColSearchService} />
                <ColumnFilterHeader label="Command" options={ctxCommands} selected={filterCommand} onToggle={(v) => toggleFilter(setFilterCommand, v)} onClear={() => setFilterCommand([])} colSearch={colSearchCommand} onColSearchChange={setColSearchCommand} />
                <th className="table-header" title="Accounting: start/stop · Authorization: profile/group · Authentication: result">Info</th>
              </tr>
            </thead>
            <tbody>
              {paged.map((log, i) => (
                <LogRow
                  key={i}
                  log={log}
                  onClickUser={(v) => toggleFilter(setFilterUser, v)}
                  onClickDevice={(v) => toggleFilter(setFilterDevice, v)}
                  onClickDeviceIp={(v) => toggleFilter(setFilterDeviceIp, v)}
                  onClickType={(v) => toggleFilter(setFilterType, v)}
                  onClickResult={(v) => toggleFilter(setFilterResult, v)}
                  onClickPort={(v) => v && toggleFilter(setFilterPort, v)}
                  onClickService={(v) => v && toggleFilter(setFilterService, v)}
                  onClickCommand={(v) => v && toggleFilter(setFilterCommand, v)}
                  activeUsers={filterUser}
                  activeDevices={filterDevice}
                  activeDeviceIps={filterDeviceIp}
                  activeTypes={filterType}
                  activeResults={filterResult}
                  activePorts={filterPort}
                  activeServices={filterService}
                  activeCommands={filterCommand}
                />
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div className="py-12 text-center" style={{ color: 'var(--s-muted)' }}>
            {logs.length === 0
              ? `No AAA events recorded ${fromDate === toDate ? `on ${fromDate}` : `between ${fromDate} and ${toDate}`} - logs appear once devices start authenticating against the server.`
              : 'No log entries match the current filters (check the date/time range).'}
          </div>
        )}
        {pager('bottom')}
      </div>
      </LoadState>
    </div>
  );
}

// ============================ Column Filter Header ============================

function ColumnFilterHeader({ label, options, selected, onToggle, onClear, colSearch, onColSearchChange }: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (v: string) => void;
  onClear: () => void;
  colSearch: string;
  onColSearchChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const ref = useRef<HTMLTableCellElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) &&
          dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
    if (open && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left });
    }
  }, [open]);

  const isActive = selected.length > 0 || colSearch !== '';
  const filteredOpts = options.filter(o => colSearch === '' || o.toLowerCase().includes(colSearch.toLowerCase()));

  return (
    <th ref={ref} className="table-header">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 hover:text-brand-magenta transition-colors"
        style={{ color: isActive ? 'var(--s-heading)' : undefined }}
      >
        {label}
        {selected.length > 0 && <span className="w-4 h-4 rounded-full bg-brand-magenta text-white text-[9px] flex items-center justify-center font-bold">{selected.length}</span>}
        {colSearch && !selected.length && <span className="w-1.5 h-1.5 rounded-full bg-brand-magenta" />}
        <ChevronDown className="w-3 h-3" />
      </button>

      {open && createPortal(
        <div
          ref={dropdownRef}
          className="fixed z-50 w-60 rounded-lg shadow-2xl"
          style={{
            backgroundColor: 'var(--s-surface)',
            border: '1px solid var(--s-border)',
            top: pos.top,
            left: pos.left,
          }}
        >
          <div className="p-2" style={{ borderBottom: '1px solid var(--s-border)' }}>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: 'var(--s-muted)' }} />
              <input
                ref={inputRef}
                type="text"
                value={colSearch}
                onChange={e => onColSearchChange(e.target.value)}
                placeholder={`Filter ${label.toLowerCase()}...`}
                className="w-full pl-7 pr-2 py-1.5 rounded text-xs font-mono focus:outline-none focus:ring-1 focus:ring-brand-purple/30"
                style={{ backgroundColor: 'var(--s-bg)', border: '1px solid var(--s-border)', color: 'var(--s-text)' }}
              />
            </div>
          </div>

          {(selected.length > 0 || colSearch !== '') && (
            <button
              onClick={() => { onClear(); onColSearchChange(''); }}
              className="w-full px-3 py-1.5 text-left text-xs text-brand-magenta hover:text-brand-pink transition-colors"
              style={{ borderBottom: '1px solid var(--s-border)' }}
            >
              Clear all
            </button>
          )}

          <div className="max-h-48 overflow-y-auto py-1">
            {filteredOpts.length === 0 && (
              <div className="px-3 py-2 text-xs" style={{ color: 'var(--s-muted)' }}>No matches</div>
            )}
            {filteredOpts.map(opt => {
              const checked = selected.includes(opt);
              return (
                <label key={opt} className="flex items-center gap-2.5 px-3 py-1.5 cursor-pointer transition-colors text-sm" style={{ color: checked ? 'var(--s-heading)' : 'var(--s-text)' }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--s-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggle(opt)}
                    className="rounded border-2 w-3.5 h-3.5 accent-[#ac4886]"
                  />
                  <span className="font-mono text-xs truncate">{opt}</span>
                </label>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </th>
  );
}

// ============================ Filter Chip ============================

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-brand-purple/15 text-brand-magenta border border-brand-purple/20">
      {label}
      <button onClick={onClear} className="hover:text-white transition-colors"><X className="w-3 h-3" /></button>
    </span>
  );
}

// ============================ Log Row ============================

function LogRow({ log, onClickUser, onClickDevice, onClickDeviceIp, onClickType, onClickResult, onClickPort, onClickService, onClickCommand, activeUsers, activeDevices, activeDeviceIps, activeTypes, activeResults, activePorts, activeServices, activeCommands }: {
  log: LogEntry;
  onClickUser: (v: string) => void;
  onClickDevice: (v: string) => void;
  onClickDeviceIp: (v: string) => void;
  onClickType: (v: string) => void;
  onClickResult: (v: string) => void;
  onClickPort: (v: string) => void;
  onClickService: (v: string) => void;
  onClickCommand: (v: string) => void;
  activeUsers: string[];
  activeDevices: string[];
  activeDeviceIps: string[];
  activeTypes: string[];
  activeResults: string[];
  activePorts: string[];
  activeServices: string[];
  activeCommands: string[];
}) {
  const ResultIcon = resultIcons[log.result];

  return (
    <tr className="table-row">
      <td className="table-cell font-mono text-xs whitespace-nowrap" style={{ color: 'var(--s-muted)' }}>{log.timestamp}</td>

      <td className="table-cell cursor-pointer" onClick={() => onClickType(log.type)}>
        <span className={`badge border capitalize ${typeColors[log.type]} ${activeTypes.includes(log.type) ? 'ring-2 ring-brand-magenta/40' : ''}`}>
          {log.type}
        </span>
      </td>

      <td className="table-cell cursor-pointer" onClick={() => onClickUser(log.user)}>
        <span className={`font-mono text-sm heading ${activeUsers.includes(log.user) ? 'underline decoration-brand-magenta decoration-2 underline-offset-2' : ''}`}>
          {log.user}
        </span>
      </td>

      <td className="table-cell cursor-pointer" onClick={() => onClickDevice(log.device)}>
        <span className={`font-mono text-sm ${activeDevices.includes(log.device) ? 'underline decoration-brand-magenta decoration-2 underline-offset-2' : ''}`} style={{ color: 'var(--s-text)' }}>
          {log.device}
        </span>
      </td>

      <td className="table-cell cursor-pointer" onClick={() => onClickDeviceIp(log.deviceIp)}>
        <span className={`font-mono text-xs ${activeDeviceIps.includes(log.deviceIp) ? 'underline decoration-brand-magenta decoration-2 underline-offset-2' : ''}`} style={{ color: 'var(--s-muted)' }}>
          {log.deviceIp}
        </span>
      </td>

      <td className={`table-cell font-mono text-xs ${log.port ? 'cursor-pointer' : ''}`} onClick={() => log.port && onClickPort(log.port)}>
        <span className={activePorts.includes(log.port ?? '') ? 'underline decoration-brand-magenta decoration-2 underline-offset-2' : ''} style={{ color: 'var(--s-muted)' }}>{log.port || '-'}</span>
      </td>

      <td className="table-cell cursor-pointer" onClick={() => onClickResult(log.result)}>
        <span className={`inline-flex items-center gap-1.5 ${resultColors[log.result]} ${activeResults.includes(log.result) ? 'ring-2 ring-current/30 rounded-full px-2 py-0.5' : ''}`}>
          <ResultIcon className="w-4 h-4" />
          <span className="text-sm font-medium">{log.result}</span>
        </span>
      </td>

      <td className={`table-cell text-sm ${log.service ? 'cursor-pointer' : ''}`} onClick={() => log.service && onClickService(log.service)}>
        <span className={activeServices.includes(log.service ?? '') ? 'underline decoration-brand-magenta decoration-2 underline-offset-2' : ''} style={{ color: 'var(--s-muted)' }}>{log.service || '-'}</span>
      </td>

      <td className={`table-cell font-mono text-xs max-w-xs truncate ${log.command ? 'cursor-pointer' : ''}`} onClick={() => log.command && onClickCommand(log.command)} title={log.command}>
        <span className={activeCommands.includes(log.command ?? '') ? 'underline decoration-brand-magenta decoration-2 underline-offset-2' : ''} style={{ color: 'var(--s-text)' }}>{log.command || '-'}</span>
      </td>

      {/* Info: type-specific - accounting start/stop, authz profile/group, authn message */}
      <td className="table-cell text-sm max-w-xs truncate" style={{ color: 'var(--s-text)' }} title={log.detail}>
        {log.detail
          ? <span className={log.type === 'accounting' ? 'capitalize' : log.type === 'authorization' ? 'font-mono text-xs' : ''}>{log.detail}</span>
          : '-'}
      </td>
    </tr>
  );
}
