import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, Filter, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';

// Table header cell with a funnel dropdown (search-as-you-type + multi-select
// checkboxes + clear), portaled to <body> so it isn't clipped by table overflow.
// Optionally sortable: the label click toggles sort when onSort is provided.
export default function ColumnFilterHeader({
  label, options, selected, onToggle, onClear, colSearch, onColSearchChange,
  sortDir, onSort, className,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (v: string) => void;
  onClear: () => void;
  colSearch: string;
  onColSearchChange: (v: string) => void;
  sortDir?: 'asc' | 'desc' | null;
  onSort?: () => void;
  className?: string;
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
  const SortIcon = onSort ? (!sortDir ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown) : null;

  return (
    <th ref={ref} className={`table-header ${className ?? ''}`}>
      <div className="flex items-center gap-1">
        {onSort ? (
          <button onClick={onSort} className="flex items-center gap-1 hover:text-brand-magenta transition-colors select-none">
            {label}
            {SortIcon && <SortIcon className="w-3 h-3" style={{ opacity: sortDir ? 0.9 : 0.35 }} />}
          </button>
        ) : (
          <span>{label}</span>
        )}
        <button
          onClick={() => setOpen(!open)}
          className="relative p-0.5 hover:text-brand-magenta transition-colors"
          style={{ color: isActive ? 'var(--s-heading)' : 'var(--s-muted)' }}
          title={`Filter ${label}`}
        >
          <Filter className="w-3.5 h-3.5" />
          {selected.length > 0 && (
            <span className="absolute -top-1.5 -right-1.5 min-w-3.5 h-3.5 px-0.5 rounded-full bg-brand-magenta text-white text-[8px] flex items-center justify-center font-bold">{selected.length}</span>
          )}
          {colSearch && selected.length === 0 && (
            <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-brand-magenta" />
          )}
        </button>
      </div>

      {open && createPortal(
        <div
          ref={dropdownRef}
          className="fixed z-50 w-60 rounded-lg shadow-2xl"
          style={{ backgroundColor: 'var(--s-surface)', border: '1px solid var(--s-border)', top: pos.top, left: pos.left }}
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
                  <input type="checkbox" checked={checked} onChange={() => onToggle(opt)} className="rounded border-2 w-3.5 h-3.5 accent-[#ac4886]" />
                  <span className="font-mono text-xs truncate">{opt || '(empty)'}</span>
                </label>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </th>
  );
}
