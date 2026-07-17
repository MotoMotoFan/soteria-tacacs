import { useMemo } from 'react';
import type { ApiScope } from '../lib/api';

// A per-resource permission picker: one row per resource with a None / Read /
// Read & Write dropdown, instead of a long flat checkbox list. It resolves to
// the underlying fine-grained scopes (read = the :read scopes; write = all of
// the resource's scopes), so enforcement is unchanged. Duplicate catalog
// entries that share a scope collapse to a single row/level.
export default function ScopeMatrix({ scopes, selected, onChange }: {
  scopes: ApiScope[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const resources = useMemo(() => {
    const map: Record<string, { read: Set<string>; write: Set<string> }> = {};
    for (const s of scopes) {
      const res = s.scope.split(':')[0];
      const action = s.scope.slice(res.length + 1);
      (map[res] ??= { read: new Set(), write: new Set() });
      if (action === 'read') map[res].read.add(s.scope);
      else map[res].write.add(s.scope);
    }
    return Object.entries(map)
      .map(([name, v]) => ({ name, read: [...v.read], write: [...v.write], all: [...v.read, ...v.write] }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [scopes]);

  const levelOf = (r: { read: string[]; write: string[]; all: string[] }): 'none' | 'read' | 'write' => {
    const hasAll = (arr: string[]) => arr.length > 0 && arr.every((s) => selected.has(s));
    if (hasAll(r.all) && r.write.length > 0) return 'write';
    if (hasAll(r.read)) return 'read';
    if (r.all.some((s) => selected.has(s))) return 'read'; // partial -> treat as read
    return 'none';
  };

  const setLevel = (r: { read: string[]; write: string[]; all: string[] }, level: string) => {
    const next = new Set(selected);
    r.all.forEach((s) => next.delete(s));
    if (level === 'read') r.read.forEach((s) => next.add(s));
    if (level === 'write') r.all.forEach((s) => next.add(s));
    onChange(next);
  };

  const pretty = (name: string) => name.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

  const setAll = (level: string) => {
    const next = new Set<string>();
    if (level !== 'none') {
      for (const r of resources) (level === 'write' ? r.all : r.read).forEach((s) => next.add(s));
    }
    onChange(next);
  };

  return (
    <div>
      <div className="flex items-center justify-end gap-3 mb-2 text-xs">
        <button type="button" onClick={() => setAll('read')} className="text-brand-magenta hover:text-brand-pink">All read</button>
        <button type="button" onClick={() => setAll('write')} className="text-brand-magenta hover:text-brand-pink">All read &amp; write</button>
        <button type="button" onClick={() => setAll('none')} className="text-brand-magenta hover:text-brand-pink">Clear</button>
      </div>
      <div className="rounded-lg overflow-hidden max-h-72 overflow-y-auto" style={{ border: '1px solid var(--s-border)' }}>
        {resources.map((r, i) => {
          const level = levelOf(r);
          return (
            <div key={r.name} className="flex items-center justify-between gap-3 px-3 py-2"
              style={{ borderTop: i > 0 ? '1px solid var(--s-border)' : undefined, backgroundColor: level !== 'none' ? 'var(--s-hover)' : 'transparent' }}>
              <span className="text-sm heading">{pretty(r.name)}</span>
              <select
                className="select-field text-xs py-1 w-40 shrink-0"
                value={level}
                onChange={(e) => setLevel(r, e.target.value)}
              >
                <option value="none">No access</option>
                {r.read.length > 0 && <option value="read">Read only</option>}
                {r.write.length > 0 && <option value="write">{r.read.length > 0 ? 'Read & Write' : 'Full access'}</option>}
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
}
