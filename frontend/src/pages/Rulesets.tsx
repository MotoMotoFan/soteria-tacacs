import { Plus, ArrowDown, ArrowUp, Shield, ShieldOff, Trash2, ChevronDown, ChevronUp, Pencil } from 'lucide-react';
import { useState } from 'react';
import { api, type Rule, type RuleCondition } from '../lib/api';
import { useApi, LoadState } from '../lib/useApi';
import Modal from '../components/Modal';

// ---- Build config preview (matches the agent's renderer) ----
function buildRulesetConfig(rules: Rule[]): string {
  let out = `ruleset {\n`;
  for (const r of rules) {
    out += `    rule {\n        enabled = ${r.enabled ? 'yes' : 'no'}\n        script {\n`;
    out += buildConditionsPreview(r.matches, 3);
    out += `            ${r.defaultAction}\n        }\n    }\n`;
  }
  out += `}`;
  return out;
}

function buildConditionsPreview(conditions: RuleCondition[], depth: number): string {
  const indent = '    '.repeat(depth);
  const inner = '    '.repeat(depth + 1);
  let out = '';
  for (const c of conditions) {
    out += `${indent}if (${c.attribute} ${c.operator} ${c.value}) {\n`;
    for (const a of c.actions) { if (a.trim()) out += `${inner}${a}\n`; }
    if (c.children.length > 0) out += buildConditionsPreview(c.children, depth + 1);
    out += `${inner}${c.defaultAction}\n`;
    if (c.elseAction || c.elseActions.length > 0) {
      out += `${indent}} else {\n`;
      for (const a of c.elseActions) { if (a.trim()) out += `${inner}${a}\n`; }
      if (c.elseAction) out += `${inner}${c.elseAction}\n`;
      out += `${indent}}\n`;
    } else {
      out += `${indent}}\n`;
    }
  }
  return out;
}

function profileOf(c: RuleCondition): string {
  for (const a of c.actions) {
    const m = /^profile\s*=\s*(\S+)/.exec(a);
    if (m) return m[1];
  }
  return '-';
}

function emptyCondition(): RuleCondition {
  return { attribute: 'member', operator: '==', value: '', actions: [''], children: [], elseActions: [], elseAction: '', defaultAction: 'permit' };
}
function emptyRule(): Rule {
  return { enabled: true, matches: [emptyCondition()], defaultAction: 'deny' };
}

/** Drop empty action strings the form editors leave behind. */
function cleanCondition(c: RuleCondition): RuleCondition {
  return {
    ...c,
    actions: c.actions.filter(a => a.trim() !== ''),
    elseActions: c.elseActions.filter(a => a.trim() !== ''),
    children: c.children.map(cleanCondition),
  };
}

// ============================ Page ============================

export default function Rulesets() {
  const { data, loading, error, reload } = useApi(api.getRules);
  const rules = data ?? [];

  const [showAddModal, setShowAddModal] = useState(false);
  const [editIdx, setEditIdx] = useState<{ blockIdx: number; matchIdx: number } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const commit = async (next: Rule[]) => {
    setActionError(null);
    try {
      await api.saveRules(next);
      await reload();
      return null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setActionError(msg);
      return msg;
    }
  };

  const moveCondition = async (blockIdx: number, matchIdx: number, dir: -1 | 1) => {
    const next = matchIdx + dir;
    const block = rules[blockIdx];
    if (next < 0 || next >= block.matches.length) return;
    const newRules = structuredClone(rules);
    const m = newRules[blockIdx].matches;
    [m[matchIdx], m[next]] = [m[next], m[matchIdx]];
    await commit(newRules);
  };

  const removeCondition = async (blockIdx: number, matchIdx: number) => {
    if (!window.confirm('Remove this condition? The change is staged until you Commit in Edit Config mode.')) return;
    const newRules = structuredClone(rules);
    newRules[blockIdx].matches.splice(matchIdx, 1);
    await commit(newRules);
  };

  const toggleBlock = async (blockIdx: number) => {
    const newRules = structuredClone(rules);
    newRules[blockIdx].enabled = !newRules[blockIdx].enabled;
    await commit(newRules);
  };

  const removeBlock = async (blockIdx: number) => {
    if (!window.confirm('Remove this entire rule block and all its conditions?')) return;
    await commit(rules.filter((_, i) => i !== blockIdx));
  };

  const updateCondition = async (blockIdx: number, matchIdx: number, updated: RuleCondition) => {
    const newRules = structuredClone(rules);
    newRules[blockIdx].matches[matchIdx] = cleanCondition(updated);
    return commit(newRules);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold heading">Rulesets</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--s-muted)' }}>Group-to-profile mapping - first match wins (top-down)</p>
        </div>
        <button onClick={() => setShowAddModal(true)} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add Rule Block
        </button>
      </div>

      <div className="glass-card p-4 flex items-center gap-3 border-l-2 border-brand-magenta">
        <ArrowDown className="w-5 h-5 text-brand-magenta shrink-0" />
        <p className="text-sm" style={{ color: 'var(--s-text)' }}>
          Rules are evaluated <span className="font-semibold heading">top-down</span>. First match wins. No match = <span className="text-red-400 font-semibold">deny</span>.
        </p>
      </div>

      {actionError && (
        <div className="glass-card p-4 border-l-2 border-red-500">
          <pre className="text-sm text-red-400 whitespace-pre-wrap">{actionError}</pre>
        </div>
      )}

      <LoadState loading={loading} error={error} onRetry={reload}>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-4">
            {/* Ruleset header */}
            <div className="px-3 py-2 rounded-lg text-xs font-semibold uppercase tracking-wider" style={{ backgroundColor: 'var(--s-bg)', color: 'var(--s-muted)', border: '1px solid var(--s-border)' }}>
              ruleset {'{'}
            </div>

            {rules.map((block, blockIdx) => (
              <div key={blockIdx} className="glass-card overflow-hidden">
                {/* Rule block header */}
                <div className="px-4 py-3 flex items-center justify-between" style={{ backgroundColor: 'var(--s-bg)', borderBottom: '1px solid var(--s-border)' }}>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs heading">rule #{blockIdx}</span>
                    <button onClick={() => toggleBlock(blockIdx)} className={block.enabled ? 'badge-success' : 'badge-warning'} title="Toggle enabled">
                      {block.enabled ? 'enabled' : 'disabled'}
                    </button>
                    <span className="text-xs font-mono" style={{ color: 'var(--s-muted)' }}>default: {block.defaultAction}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs" style={{ color: 'var(--s-muted)' }}>{block.matches.length} condition{block.matches.length !== 1 ? 's' : ''}</span>
                    <button onClick={() => removeBlock(blockIdx)} className="text-red-400 hover:text-red-300 p-1" title="Remove rule block">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Conditions inside this rule block */}
                <div className="p-2 space-y-2">
                  {block.matches.map((match, matchIdx) => (
                    <div key={matchIdx} className={`p-3 rounded-lg flex items-center gap-3 border-l-2 ${match.defaultAction === 'deny' ? 'border-red-500/50' : 'border-emerald-500/50'}`} style={{ backgroundColor: 'var(--s-bg)' }}>
                      {/* Reorder - scoped to this block */}
                      <div className="flex flex-col gap-0.5 shrink-0">
                        <button onClick={() => moveCondition(blockIdx, matchIdx, -1)} disabled={matchIdx === 0} className="p-0.5 rounded disabled:opacity-20" style={{ color: 'var(--s-muted)' }}><ArrowUp className="w-3 h-3" /></button>
                        <button onClick={() => moveCondition(blockIdx, matchIdx, 1)} disabled={matchIdx === block.matches.length - 1} className="p-0.5 rounded disabled:opacity-20" style={{ color: 'var(--s-muted)' }}><ArrowDown className="w-3 h-3" /></button>
                      </div>

                      <div className="w-7 h-7 rounded flex items-center justify-center shrink-0" style={{ backgroundColor: 'var(--s-card)' }}>
                        <span className="text-xs font-bold" style={{ color: 'var(--s-muted)' }}>#{matchIdx + 1}</span>
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-xs" style={{ color: 'var(--s-muted)' }}>if ({match.attribute} {match.operator}</span>
                          <span className="font-mono text-sm font-medium heading">{match.value}</span>
                          <span className="font-mono text-xs" style={{ color: 'var(--s-muted)' }}>)</span>
                          <span style={{ color: 'var(--s-muted)' }}>→</span>
                          <span className="font-mono text-sm" style={{ color: 'var(--s-text)' }}>{profileOf(match)}</span>
                        </div>
                        {(match.children.length > 0 || match.elseAction || match.elseActions.length > 0) && (
                          <p className="text-xs mt-0.5" style={{ color: 'var(--s-muted)' }}>
                            {match.children.length > 0 && `${match.children.length} nested condition${match.children.length !== 1 ? 's' : ''}`}
                            {match.children.length > 0 && (match.elseAction || match.elseActions.length > 0) && ' · '}
                            {(match.elseAction || match.elseActions.length > 0) && 'has else block'}
                          </p>
                        )}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {match.defaultAction === 'permit' ? (
                          <span className="badge-success flex items-center gap-1"><Shield className="w-3 h-3" /> Permit</span>
                        ) : (
                          <span className="badge-danger flex items-center gap-1"><ShieldOff className="w-3 h-3" /> Deny</span>
                        )}
                        <button onClick={() => setEditIdx({ blockIdx, matchIdx })} className="p-1 rounded" style={{ color: 'var(--s-muted)' }}>
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => removeCondition(blockIdx, matchIdx)} className="p-1 rounded text-red-400 hover:text-red-300">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                  {block.matches.length === 0 && (
                    <div className="p-3 text-center text-xs" style={{ color: 'var(--s-muted)' }}>No conditions - the block's default action ({block.defaultAction}) always applies.</div>
                  )}
                </div>
              </div>
            ))}

            {/* Closing brace */}
            <div className="px-3 py-2 rounded-lg text-xs font-semibold uppercase tracking-wider" style={{ backgroundColor: 'var(--s-bg)', color: 'var(--s-muted)', border: '1px solid var(--s-border)' }}>
              {'}'}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--s-muted)' }}>Generated 08-ruleset.cfg</label>
            <pre className="config-preview whitespace-pre min-h-[280px]">{buildRulesetConfig(rules)}</pre>
          </div>
        </div>
      </LoadState>

      <Modal open={showAddModal} onClose={() => setShowAddModal(false)} title="Add Rule Block" maxWidth="max-w-5xl">
        <RuleFormEditor
          onClose={() => setShowAddModal(false)}
          onSubmit={async form => commit([...rules, { ...form, matches: form.matches.map(cleanCondition) }])}
        />
      </Modal>

      <Modal open={editIdx !== null} onClose={() => setEditIdx(null)} title="Edit Condition" maxWidth="max-w-lg">
        {editIdx !== null && rules[editIdx.blockIdx]?.matches[editIdx.matchIdx] && (
          <EditConditionForm
            condition={rules[editIdx.blockIdx].matches[editIdx.matchIdx]}
            onClose={() => setEditIdx(null)}
            onSave={async updated => {
              const err = await updateCondition(editIdx.blockIdx, editIdx.matchIdx, updated);
              if (!err) setEditIdx(null);
              return err;
            }}
          />
        )}
      </Modal>
    </div>
  );
}

// ============================ Simple Condition Edit ============================

function EditConditionForm({ condition, onClose, onSave }: {
  condition: RuleCondition;
  onClose: () => void;
  onSave: (c: RuleCondition) => Promise<string | null>;
}) {
  const [attribute, setAttribute] = useState(condition.attribute);
  const [operator, setOperator] = useState(condition.operator);
  const [value, setValue] = useState(condition.value);
  const [profile, setProfile] = useState(() => {
    const p = profileOf(condition);
    return p === '-' ? '' : p;
  });
  const [defaultAction, setDefaultAction] = useState(condition.defaultAction);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Replace/insert the `profile = X` action, keep any other actions.
    const otherActions = condition.actions.filter(a => !/^profile\s*=/.test(a));
    const actions = profile.trim() ? [`profile = ${profile.trim()}`, ...otherActions] : otherActions;
    setFormError(null);
    setSaving(true);
    const err = await onSave({ ...condition, attribute, operator, value, actions, defaultAction });
    setSaving(false);
    if (err) setFormError(err);
  };

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Attribute</label>
          <input className="input-field font-mono" value={attribute} onChange={e => setAttribute(e.target.value)} />
        </div>
        <div className="w-20">
          <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Op</label>
          <select className="select-field font-mono" value={operator} onChange={e => setOperator(e.target.value)}>
            <option value="==">==</option>
            <option value="!=">!=</option>
            <option value="=~">=~</option>
          </select>
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Value (group name or /regex/)</label>
        <input className="input-field font-mono" value={value} onChange={e => setValue(e.target.value)} />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Profile</label>
        <input className="input-field font-mono" placeholder="e.g. tacacs_admin" value={profile} onChange={e => setProfile(e.target.value)} />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Action</label>
        <select className="select-field" value={defaultAction} onChange={e => setDefaultAction(e.target.value)}>
          <option value="permit">permit</option>
          <option value="deny">deny</option>
        </select>
      </div>
      {formError && <p className="text-sm text-red-400 whitespace-pre-wrap">{formError}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
        <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Committing…' : 'Save'}</button>
      </div>
    </form>
  );
}

// ============================ Full Add Rule Block Form ============================

function RuleFormEditor({ onClose, onSubmit }: { onClose: () => void; onSubmit: (r: Rule) => Promise<string | null> }) {
  const [form, setForm] = useState<Rule>(emptyRule());
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const updateMatch = (mi: number, patch: Partial<RuleCondition>) => {
    const m = [...form.matches]; m[mi] = { ...m[mi], ...patch }; setForm({ ...form, matches: m });
  };
  const updateMatchAction = (mi: number, ai: number, val: string) => {
    const m = [...form.matches]; const a = [...m[mi].actions]; a[ai] = val; m[mi] = { ...m[mi], actions: a }; setForm({ ...form, matches: m });
  };
  const addMatchAction = (mi: number) => {
    const m = [...form.matches]; m[mi] = { ...m[mi], actions: [...m[mi].actions, ''] }; setForm({ ...form, matches: m });
  };
  const addMatch = () => setForm({ ...form, matches: [...form.matches, emptyCondition()] });
  const removeMatch = (mi: number) => setForm({ ...form, matches: form.matches.filter((_, i) => i !== mi) });
  const addChild = (mi: number) => {
    const m = [...form.matches]; m[mi] = { ...m[mi], children: [...m[mi].children, emptyCondition()] }; setForm({ ...form, matches: m });
  };
  const updateChild = (mi: number, ci: number, patch: Partial<RuleCondition>) => {
    const m = [...form.matches]; const c = [...m[mi].children]; c[ci] = { ...c[ci], ...patch }; m[mi] = { ...m[mi], children: c }; setForm({ ...form, matches: m });
  };
  const updateChildAction = (mi: number, ci: number, ai: number, val: string) => {
    const m = [...form.matches]; const c = [...m[mi].children]; const a = [...c[ci].actions]; a[ai] = val; c[ci] = { ...c[ci], actions: a }; m[mi] = { ...m[mi], children: c }; setForm({ ...form, matches: m });
  };
  const removeChild = (mi: number, ci: number) => {
    const m = [...form.matches]; m[mi] = { ...m[mi], children: m[mi].children.filter((_, i) => i !== ci) }; setForm({ ...form, matches: m });
  };
  const addElseAction = (mi: number) => {
    const m = [...form.matches]; m[mi] = { ...m[mi], elseActions: [...m[mi].elseActions, ''] }; setForm({ ...form, matches: m });
  };
  const updateElseAction = (mi: number, ai: number, val: string) => {
    const m = [...form.matches]; const ea = [...m[mi].elseActions]; ea[ai] = val; m[mi] = { ...m[mi], elseActions: ea }; setForm({ ...form, matches: m });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSaving(true);
    const err = await onSubmit(form);
    setSaving(false);
    if (err) { setFormError(err); return; }
    onClose();
  };

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-4 max-h-[65vh] overflow-y-auto pr-2">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--s-text)' }}>
              <input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} className="rounded" /> Enabled
            </label>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--s-text)' }}>Default Action</label>
              <select className="select-field text-sm" value={form.defaultAction} onChange={e => setForm({ ...form, defaultAction: e.target.value })}>
                <option value="deny">deny</option><option value="permit">permit</option>
              </select>
            </div>
          </div>

          <label className="block text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--s-muted)' }}>Conditions</label>

          {form.matches.map((match, mi) => (
            <MatchEditor key={mi} mi={mi} match={match} onUpdate={updateMatch} onRemove={removeMatch}
              onAddAction={addMatchAction} onUpdateAction={updateMatchAction}
              onAddChild={addChild} onUpdateChild={updateChild} onRemoveChild={removeChild} onUpdateChildAction={updateChildAction}
              onAddElseAction={addElseAction} onUpdateElseAction={updateElseAction} />
          ))}
          <button type="button" onClick={addMatch} className="btn-ghost text-sm w-full">+ Add Condition</button>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-muted)' }}>Config Preview</label>
          <pre className="config-preview whitespace-pre min-h-[400px] max-h-[65vh] overflow-y-auto">{buildRulesetConfig([form])}</pre>
        </div>
      </div>
      {formError && <p className="text-sm text-red-400 whitespace-pre-wrap">{formError}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
        <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Committing…' : 'Add Rule Block'}</button>
      </div>
    </form>
  );
}

// ============================ Match Editor ============================

function MatchEditor({ mi, match, onUpdate, onRemove, onAddAction, onUpdateAction, onAddChild, onUpdateChild, onRemoveChild, onUpdateChildAction, onAddElseAction, onUpdateElseAction }: {
  mi: number; match: RuleCondition;
  onUpdate: (mi: number, p: Partial<RuleCondition>) => void;
  onRemove: (mi: number) => void;
  onAddAction: (mi: number) => void;
  onUpdateAction: (mi: number, ai: number, v: string) => void;
  onAddChild: (mi: number) => void;
  onUpdateChild: (mi: number, ci: number, p: Partial<RuleCondition>) => void;
  onRemoveChild: (mi: number, ci: number) => void;
  onUpdateChildAction: (mi: number, ci: number, ai: number, v: string) => void;
  onAddElseAction: (mi: number) => void;
  onUpdateElseAction: (mi: number, ai: number, v: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [showElse, setShowElse] = useState(match.elseAction !== '' || match.elseActions.length > 0);

  return (
    <div className="rounded-lg p-4 space-y-3" style={{ backgroundColor: 'var(--s-bg)', border: '1px solid var(--s-border)' }}>
      <div className="flex items-center justify-between">
        <button type="button" onClick={() => setExpanded(!expanded)} className="flex items-center gap-2 text-sm font-semibold heading">
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          if ({match.attribute} {match.operator} {match.value || '...'})
        </button>
        <button type="button" onClick={() => onRemove(mi)} className="text-red-400 hover:text-red-300 p-1"><Trash2 className="w-3.5 h-3.5" /></button>
      </div>

      {expanded && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <input className="input-field font-mono text-xs w-28" placeholder="member" value={match.attribute} onChange={e => onUpdate(mi, { attribute: e.target.value })} />
            <select className="select-field text-xs w-16 font-mono" value={match.operator} onChange={e => onUpdate(mi, { operator: e.target.value })}>
              <option value="==">==</option><option value="!=">!=</option><option value="=~">=~</option>
            </select>
            <input className="input-field font-mono text-xs flex-1" placeholder="tacacs_admin or /regex/" value={match.value} onChange={e => onUpdate(mi, { value: e.target.value })} />
          </div>
          <div className="flex items-center gap-2">
            <label className="block text-xs font-medium" style={{ color: 'var(--s-muted)' }}>Default:</label>
            <select className="select-field text-xs w-20 font-mono" value={match.defaultAction} onChange={e => onUpdate(mi, { defaultAction: e.target.value })}>
              <option value="permit">permit</option><option value="deny">deny</option>
            </select>
          </div>
          <div className="space-y-1 pl-2">
            <label className="block text-xs font-medium" style={{ color: 'var(--s-muted)' }}>Actions</label>
            {match.actions.map((a, ai) => (
              <input key={ai} className="input-field font-mono text-xs" placeholder="profile = tacacs_admin" value={a} onChange={e => onUpdateAction(mi, ai, e.target.value)} />
            ))}
            <button type="button" onClick={() => onAddAction(mi)} className="text-[10px] hover:underline" style={{ color: 'var(--s-muted)' }}>+ action</button>
          </div>
          {match.children.length > 0 && (
            <div className="pl-3 space-y-2" style={{ borderLeft: '2px solid var(--s-border)' }}>
              <label className="block text-xs font-medium" style={{ color: 'var(--s-muted)' }}>Nested Conditions</label>
              {match.children.map((child, ci) => (
                <div key={ci} className="rounded-md p-3 space-y-2" style={{ backgroundColor: 'var(--s-card)', border: '1px solid var(--s-border)' }}>
                  <div className="flex items-center gap-2">
                    <input className="input-field font-mono text-xs w-24" placeholder="nas-name" value={child.attribute} onChange={e => onUpdateChild(mi, ci, { attribute: e.target.value })} />
                    <select className="select-field text-xs w-16 font-mono" value={child.operator} onChange={e => onUpdateChild(mi, ci, { operator: e.target.value })}>
                      <option value="==">==</option><option value="!=">!=</option><option value="=~">=~</option>
                    </select>
                    <input className="input-field font-mono text-xs flex-1" placeholder="/^(SWCORE|BG)/" value={child.value} onChange={e => onUpdateChild(mi, ci, { value: e.target.value })} />
                    <button type="button" onClick={() => onRemoveChild(mi, ci)} className="text-red-400 p-1"><Trash2 className="w-3 h-3" /></button>
                  </div>
                  {child.actions.map((a, ai) => (
                    <input key={ai} className="input-field font-mono text-xs" placeholder="profile = tacacs_readonly" value={a} onChange={e => onUpdateChildAction(mi, ci, ai, e.target.value)} />
                  ))}
                  <select className="select-field text-xs w-20 font-mono" value={child.defaultAction} onChange={e => onUpdateChild(mi, ci, { defaultAction: e.target.value })}>
                    <option value="permit">permit</option><option value="deny">deny</option>
                  </select>
                </div>
              ))}
            </div>
          )}
          <button type="button" onClick={() => onAddChild(mi)} className="text-[10px] hover:underline" style={{ color: 'var(--s-muted)' }}>+ nested condition</button>
          <div>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: 'var(--s-muted)' }}>
              <input type="checkbox" checked={showElse} onChange={e => { setShowElse(e.target.checked); if (!e.target.checked) onUpdate(mi, { elseAction: '', elseActions: [] }); }} className="rounded" />
              else block
            </label>
            {showElse && (
              <div className="mt-2 pl-3 space-y-1" style={{ borderLeft: '2px solid var(--s-border)' }}>
                {match.elseActions.map((a, ai) => (
                  <input key={ai} className="input-field font-mono text-xs" placeholder="profile = tacacs_admin" value={a} onChange={e => onUpdateElseAction(mi, ai, e.target.value)} />
                ))}
                <button type="button" onClick={() => onAddElseAction(mi)} className="text-[10px] hover:underline" style={{ color: 'var(--s-muted)' }}>+ else action</button>
                <div className="flex gap-2 items-center mt-1">
                  <label className="text-xs" style={{ color: 'var(--s-muted)' }}>else default:</label>
                  <select className="select-field text-xs w-20 font-mono" value={match.elseAction} onChange={e => onUpdate(mi, { elseAction: e.target.value })}>
                    <option value="">none</option><option value="permit">permit</option><option value="deny">deny</option>
                  </select>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
