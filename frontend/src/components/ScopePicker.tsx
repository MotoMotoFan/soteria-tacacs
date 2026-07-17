import { useMemo } from 'react';
import type { ApiScope } from '../lib/api';

// Grouped scope checkboxes (by section) with a select-all per section.
export default function ScopePicker({ scopes, selected, onToggle, onToggleSection }: {
  scopes: ApiScope[];
  selected: Set<string>;
  onToggle: (scope: string) => void;
  onToggleSection: (scopesInSection: string[], allOn: boolean) => void;
}) {
  const grouped = useMemo(() => {
    const g: Record<string, ApiScope[]> = {};
    for (const s of scopes) (g[s.scope.split(':')[0]] ??= []).push(s);
    return g;
  }, [scopes]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-72 overflow-y-auto pr-1">
      {Object.keys(grouped).sort().map((section) => {
        const items = grouped[section];
        const inSection = items.map((s) => s.scope);
        const allOn = inSection.every((s) => selected.has(s));
        return (
          <div key={section} className="rounded-lg p-3" style={{ border: '1px solid var(--s-border)' }}>
            <button type="button" onClick={() => onToggleSection(inSection, allOn)} className="flex items-center justify-between w-full mb-2">
              <span className="text-sm font-semibold heading capitalize">{section.replace(/-/g, ' ')}</span>
              <span className="text-xs text-brand-magenta">{allOn ? 'Clear' : 'Select all'}</span>
            </button>
            <div className="space-y-1.5">
              {items.map((s) => (
                <label key={s.scope} className="flex items-start gap-2 text-sm cursor-pointer" title={`${s.method} ${s.path}`}>
                  <input type="checkbox" className="mt-0.5 accent-brand-magenta" checked={selected.has(s.scope)} onChange={() => onToggle(s.scope)} />
                  <span className="min-w-0">
                    <span className="font-mono text-xs" style={{ color: 'var(--s-text)' }}>{s.scope}</span>
                    <span className="block text-xs truncate" style={{ color: 'var(--s-muted)' }}>{s.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
