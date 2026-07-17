import { Plus, ShieldCheck, Terminal, Crown, Trash2, ChevronDown, ChevronUp, Pencil } from 'lucide-react';
import { useState } from 'react';
import { api, type Profile, type ServiceRule, type ConditionRule } from '../lib/api';
import { useApi, LoadState } from '../lib/useApi';
import Modal from '../components/Modal';

// ---- Build config preview (matches the agent's renderer) ----
function buildProfileConfig(p: Profile): string {
  if (!p.name && p.services.length === 0) return '# Fill in the fields to preview the config';

  let out = `profile ${p.name || '<name>'} {\n    script {\n`;

  for (const svc of p.services) {
    out += `        if (service == ${svc.service || '<service>'}) {\n`;
    for (const a of svc.actions) {
      if (a.trim()) out += `            ${a}\n`;
    }
    for (const c of svc.conditions) {
      if (c.inline) {
        out += `            if (${c.attribute} ${c.operator} ${c.value}) ${c.inlineAction}\n`;
      } else {
        const val = c.operator === '=~' ? c.value : `"${c.value}"`;
        out += `            if (${c.attribute} ${c.operator} ${val}) {\n`;
        for (const a of c.actions) {
          if (a.trim()) out += `                ${a}\n`;
        }
        out += `                ${c.defaultAction}\n`;
        out += `            }\n`;
      }
    }
    out += `            ${svc.defaultAction}\n`;
    out += `        }\n`;
  }

  out += `        ${p.defaultAction}\n    }\n}`;
  return out;
}

// ---- Derive display metadata from the nested structure ----
function privLevelOf(p: Profile): number | null {
  const re = /set\s+priv-lvl\s*=\s*(\d+)/;
  for (const svc of p.services) {
    for (const a of svc.actions) {
      const m = re.exec(a);
      if (m) return parseInt(m[1], 10);
    }
    for (const c of svc.conditions) {
      for (const a of [...c.actions, c.inlineAction]) {
        const m = re.exec(a ?? '');
        if (m) return parseInt(m[1], 10);
      }
    }
  }
  return null;
}

function shellAccessOf(p: Profile): 'full' | 'restricted' | 'denied' {
  const shell = p.services.find(s => s.service === 'shell');
  if (!shell) return 'denied';
  if (shell.defaultAction === 'permit') {
    const restricting = shell.conditions.some(c => c.attribute === 'cmd' && (c.defaultAction === 'deny' || c.inlineAction === 'deny'));
    return restricting ? 'restricted' : 'full';
  }
  return shell.conditions.length > 0 ? 'restricted' : 'denied';
}

function emptyCondition(): ConditionRule {
  return { attribute: 'cmd', operator: '==', value: '', actions: [''], inline: false, inlineAction: 'permit', defaultAction: 'permit' };
}

function emptyService(): ServiceRule {
  return { service: 'shell', actions: [], conditions: [emptyCondition()], defaultAction: 'deny' };
}

function emptyProfile(): Profile {
  return { name: '', services: [emptyService()], defaultAction: 'deny' };
}

/** Drop empty action strings the form editors leave behind. */
function cleanProfile(p: Profile): Profile {
  return {
    ...p,
    name: p.name.trim(),
    services: p.services.map(svc => ({
      ...svc,
      actions: svc.actions.filter(a => a.trim() !== ''),
      conditions: svc.conditions.map(c => ({ ...c, actions: c.actions.filter(a => a.trim() !== '') })),
    })),
  };
}

// ============================ Page ============================

export default function Profiles() {
  const { data, loading, error, reload } = useApi(api.getProfiles);
  const groupsQuery = useApi(api.getGroups);
  const profiles = data ?? [];
  const groups = groupsQuery.data ?? [];

  const [showAddModal, setShowAddModal] = useState(false);
  const [editProfile, setEditProfile] = useState<Profile | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const assignedGroups = (name: string) => groups.filter(g => g.profile === name).length;

  const commit = async (next: Profile[]) => {
    setActionError(null);
    try {
      await api.saveProfiles(next);
      await reload();
      return null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setActionError(msg);
      return msg;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold heading">Profiles</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--s-muted)' }}>Authorization profiles - privilege levels and command rules</p>
        </div>
        <button onClick={() => setShowAddModal(true)} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add Profile
        </button>
      </div>

      {actionError && (
        <div className="glass-card p-4 border-l-2 border-red-500">
          <pre className="text-sm text-red-400 whitespace-pre-wrap">{actionError}</pre>
        </div>
      )}

      <LoadState loading={loading} error={error} onRetry={reload}>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {profiles.map(profile => {
            const priv = privLevelOf(profile);
            const shell = shellAccessOf(profile);
            return (
              <div key={profile.name} className="glass-card-hover p-6">
                <div className="flex items-center justify-between mb-5">
                  <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                      (priv ?? 0) >= 15 ? 'bg-gradient-to-br from-brand-purple/30 to-brand-magenta/20' : 'bg-blue-500/15'
                    }`}>
                      {(priv ?? 0) >= 15 ? <Crown className="w-6 h-6 text-brand-pink" /> : <ShieldCheck className="w-6 h-6 text-blue-400" />}
                    </div>
                    <div>
                      <h3 className="text-lg font-bold font-mono heading">{profile.name}</h3>
                      <span className={(priv ?? 0) >= 15 ? 'badge-admin' : 'badge-readonly'}>
                        {priv !== null ? `Privilege Level ${priv}` : 'No priv-lvl set'}
                      </span>
                    </div>
                  </div>
                  <button onClick={() => setEditProfile(profile)} className="p-2 rounded-lg transition-colors" style={{ color: 'var(--s-muted)' }}>
                    <Pencil className="w-4 h-4" />
                  </button>
                </div>
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between items-center">
                    <span className="flex items-center gap-1.5" style={{ color: 'var(--s-muted)' }}><Terminal className="w-3.5 h-3.5" /> Shell Access</span>
                    <span className={shell === 'full' ? 'badge-success' : shell === 'restricted' ? 'badge-warning' : 'badge-danger'}>{shell}</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--s-muted)' }}>Assigned Groups</span>
                    <span className="font-medium heading">{assignedGroups(profile.name)}</span>
                  </div>
                </div>
                <div className="mt-4">
                  <pre className="config-preview">{buildProfileConfig(profile)}</pre>
                </div>
              </div>
            );
          })}
          {profiles.length === 0 && (
            <div className="glass-card py-12 text-center lg:col-span-2" style={{ color: 'var(--s-muted)' }}>No profiles configured yet.</div>
          )}
        </div>
      </LoadState>

      <Modal open={showAddModal} onClose={() => setShowAddModal(false)} title="Add Profile" maxWidth="max-w-5xl">
        <ProfileFormEditor profiles={profiles} onCommit={commit} onClose={() => setShowAddModal(false)} />
      </Modal>

      <Modal open={!!editProfile} onClose={() => setEditProfile(null)} title="Edit Profile" maxWidth="max-w-5xl">
        {editProfile && (
          <ProfileFormEditor profiles={profiles} onCommit={commit} onClose={() => setEditProfile(null)} initial={editProfile} />
        )}
      </Modal>
    </div>
  );
}

// ============================ Add/Edit Profile Form ============================

function ProfileFormEditor({ profiles, onCommit, onClose, initial }: {
  profiles: Profile[];
  onCommit: (next: Profile[]) => Promise<string | null>;
  onClose: () => void;
  initial?: Profile;
}) {
  const [form, setForm] = useState<Profile>(initial ? structuredClone(initial) : emptyProfile());
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const updateService = (si: number, patch: Partial<ServiceRule>) => {
    const s = [...form.services];
    s[si] = { ...s[si], ...patch };
    setForm({ ...form, services: s });
  };

  const updateCondition = (si: number, ci: number, patch: Partial<ConditionRule>) => {
    const s = [...form.services];
    const conds = [...s[si].conditions];
    conds[ci] = { ...conds[ci], ...patch };
    s[si] = { ...s[si], conditions: conds };
    setForm({ ...form, services: s });
  };

  const addCondition = (si: number) => {
    const s = [...form.services];
    s[si] = { ...s[si], conditions: [...s[si].conditions, emptyCondition()] };
    setForm({ ...form, services: s });
  };

  const removeCondition = (si: number, ci: number) => {
    const s = [...form.services];
    s[si] = { ...s[si], conditions: s[si].conditions.filter((_, i) => i !== ci) };
    setForm({ ...form, services: s });
  };

  const addServiceAction = (si: number) => {
    const s = [...form.services];
    s[si] = { ...s[si], actions: [...s[si].actions, ''] };
    setForm({ ...form, services: s });
  };

  const updateServiceAction = (si: number, ai: number, val: string) => {
    const s = [...form.services];
    const actions = [...s[si].actions];
    actions[ai] = val;
    s[si] = { ...s[si], actions };
    setForm({ ...form, services: s });
  };

  const removeServiceAction = (si: number, ai: number) => {
    const s = [...form.services];
    s[si] = { ...s[si], actions: s[si].actions.filter((_, i) => i !== ai) };
    setForm({ ...form, services: s });
  };

  const updateCondAction = (si: number, ci: number, ai: number, val: string) => {
    const s = [...form.services];
    const conds = [...s[si].conditions];
    const actions = [...conds[ci].actions];
    actions[ai] = val;
    conds[ci] = { ...conds[ci], actions };
    s[si] = { ...s[si], conditions: conds };
    setForm({ ...form, services: s });
  };

  const addCondAction = (si: number, ci: number) => {
    const s = [...form.services];
    const conds = [...s[si].conditions];
    conds[ci] = { ...conds[ci], actions: [...conds[ci].actions, ''] };
    s[si] = { ...s[si], conditions: conds };
    setForm({ ...form, services: s });
  };

  const addService = () => setForm({ ...form, services: [...form.services, emptyService()] });

  const removeService = (si: number) => setForm({ ...form, services: form.services.filter((_, i) => i !== si) });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const cleaned = cleanProfile(form);
    if (!cleaned.name) { setFormError('Profile name is required.'); return; }
    if (!initial && profiles.some(p => p.name === cleaned.name)) {
      setFormError(`Profile "${cleaned.name}" already exists.`);
      return;
    }
    const next = initial
      ? profiles.map(p => (p.name === initial.name ? cleaned : p))
      : [...profiles, cleaned];
    setSaving(true);
    const err = await onCommit(next);
    setSaving(false);
    if (err) { setFormError(err); return; }
    onClose();
  };

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left - form */}
        <div className="space-y-5 max-h-[65vh] overflow-y-auto pr-2">
          {/* Name + Default */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: 'var(--s-text)' }}>Profile Name</label>
              <input className="input-field font-mono text-sm" placeholder="e.g. cisco_readonly" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} disabled={!!initial} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: 'var(--s-text)' }}>Default Action</label>
              <select className="select-field text-sm" value={form.defaultAction} onChange={e => setForm({ ...form, defaultAction: e.target.value })}>
                <option value="deny">deny</option>
                <option value="permit">permit</option>
              </select>
            </div>
          </div>

          {/* Services */}
          {form.services.map((svc, si) => (
            <ServiceEditor
              key={si}
              si={si}
              svc={svc}
              onUpdateService={updateService}
              onRemoveService={removeService}
              onAddCondition={addCondition}
              onUpdateCondition={updateCondition}
              onRemoveCondition={removeCondition}
              onAddServiceAction={addServiceAction}
              onUpdateServiceAction={updateServiceAction}
              onRemoveServiceAction={removeServiceAction}
              onAddCondAction={addCondAction}
              onUpdateCondAction={updateCondAction}
            />
          ))}
          <button type="button" onClick={addService} className="btn-ghost text-sm w-full">+ Add Service</button>
        </div>

        {/* Right - live config */}
        <div>
          <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-muted)' }}>Config Preview (07-profiles.cfg)</label>
          <pre className="config-preview whitespace-pre min-h-[400px] max-h-[65vh] overflow-y-auto">{buildProfileConfig(form)}</pre>
        </div>
      </div>

      {formError && <p className="text-sm text-red-400">{formError}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
        <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Committing…' : initial ? 'Save Changes' : 'Create Profile'}</button>
      </div>
    </form>
  );
}

// ============================ Service Editor ============================

function ServiceEditor({ si, svc, onUpdateService, onRemoveService, onAddCondition, onUpdateCondition, onRemoveCondition, onAddServiceAction, onUpdateServiceAction, onRemoveServiceAction, onAddCondAction, onUpdateCondAction }: {
  si: number; svc: ServiceRule;
  onUpdateService: (si: number, p: Partial<ServiceRule>) => void;
  onRemoveService: (si: number) => void;
  onAddCondition: (si: number) => void;
  onUpdateCondition: (si: number, ci: number, p: Partial<ConditionRule>) => void;
  onRemoveCondition: (si: number, ci: number) => void;
  onAddServiceAction: (si: number) => void;
  onUpdateServiceAction: (si: number, ai: number, v: string) => void;
  onRemoveServiceAction: (si: number, ai: number) => void;
  onAddCondAction: (si: number, ci: number) => void;
  onUpdateCondAction: (si: number, ci: number, ai: number, v: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="rounded-lg p-4 space-y-3" style={{ backgroundColor: 'var(--s-bg)', border: '1px solid var(--s-border)' }}>
      <div className="flex items-center justify-between">
        <button type="button" onClick={() => setExpanded(!expanded)} className="flex items-center gap-2 text-sm font-semibold heading">
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          Service: {svc.service || '...'}
        </button>
        <button type="button" onClick={() => onRemoveService(si)} className="text-red-400 hover:text-red-300 p-1"><Trash2 className="w-3.5 h-3.5" /></button>
      </div>

      {expanded && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--s-muted)' }}>Service Name</label>
              <input className="input-field font-mono text-sm" placeholder="shell, junos-exec, etc." value={svc.service} onChange={e => onUpdateService(si, { service: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--s-muted)' }}>Default Action</label>
              <select className="select-field text-sm" value={svc.defaultAction} onChange={e => onUpdateService(si, { defaultAction: e.target.value })}>
                <option value="deny">deny</option>
                <option value="permit">permit</option>
              </select>
            </div>
          </div>

          {/* Direct set actions (Juniper style) */}
          {svc.actions.length > 0 && (
            <div className="space-y-1">
              <label className="block text-xs font-medium" style={{ color: 'var(--s-muted)' }}>Service-level Actions (set)</label>
              {svc.actions.map((a, ai) => (
                <div key={ai} className="flex gap-2">
                  <input className="input-field font-mono text-xs flex-1" placeholder='set allow-commands = "show.*"' value={a} onChange={e => onUpdateServiceAction(si, ai, e.target.value)} />
                  <button type="button" onClick={() => onRemoveServiceAction(si, ai)} className="text-red-400 hover:text-red-300 p-1"><Trash2 className="w-3 h-3" /></button>
                </div>
              ))}
            </div>
          )}
          <button type="button" onClick={() => onAddServiceAction(si)} className="text-xs hover:underline" style={{ color: 'var(--s-muted)' }}>+ set action</button>

          {/* Conditions */}
          <div className="space-y-2">
            <label className="block text-xs font-medium" style={{ color: 'var(--s-muted)' }}>Conditions</label>
            {svc.conditions.map((cond, ci) => (
              <ConditionEditor key={ci} si={si} ci={ci} cond={cond} onUpdate={onUpdateCondition} onRemove={onRemoveCondition} onAddAction={onAddCondAction} onUpdateAction={onUpdateCondAction} />
            ))}
            <button type="button" onClick={() => onAddCondition(si)} className="text-xs hover:underline" style={{ color: 'var(--s-muted)' }}>+ condition</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================ Condition Editor ============================

function ConditionEditor({ si, ci, cond, onUpdate, onRemove, onAddAction, onUpdateAction }: {
  si: number; ci: number; cond: ConditionRule;
  onUpdate: (si: number, ci: number, p: Partial<ConditionRule>) => void;
  onRemove: (si: number, ci: number) => void;
  onAddAction: (si: number, ci: number) => void;
  onUpdateAction: (si: number, ci: number, ai: number, v: string) => void;
}) {
  return (
    <div className="rounded-md p-3 space-y-2" style={{ backgroundColor: 'var(--s-card)', border: '1px solid var(--s-border)' }}>
      <div className="flex items-center gap-2">
        <input className="input-field font-mono text-xs w-24" placeholder="cmd" value={cond.attribute} onChange={e => onUpdate(si, ci, { attribute: e.target.value })} />
        <select className="select-field text-xs w-16 font-mono" value={cond.operator} onChange={e => onUpdate(si, ci, { operator: e.target.value })}>
          <option value="==">==</option>
          <option value="!=">!=</option>
          <option value="=~">=~</option>
        </select>
        <input className="input-field font-mono text-xs flex-1" placeholder={'value or /regex/'} value={cond.value} onChange={e => onUpdate(si, ci, { value: e.target.value })} />
        <button type="button" onClick={() => onRemove(si, ci)} className="text-red-400 hover:text-red-300 p-1 shrink-0"><Trash2 className="w-3 h-3" /></button>
      </div>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: 'var(--s-muted)' }}>
          <input type="checkbox" checked={cond.inline} onChange={e => onUpdate(si, ci, { inline: e.target.checked })} className="rounded" />
          Inline
        </label>
        {cond.inline ? (
          <select className="select-field text-xs w-20 font-mono" value={cond.inlineAction} onChange={e => onUpdate(si, ci, { inlineAction: e.target.value })}>
            <option value="permit">permit</option>
            <option value="deny">deny</option>
          </select>
        ) : (
          <select className="select-field text-xs w-20 font-mono" value={cond.defaultAction} onChange={e => onUpdate(si, ci, { defaultAction: e.target.value })}>
            <option value="permit">permit</option>
            <option value="deny">deny</option>
          </select>
        )}
      </div>

      {/* Block actions (only if not inline) */}
      {!cond.inline && (
        <div className="space-y-1 pl-2">
          {cond.actions.map((a, ai) => (
            <input key={ai} className="input-field font-mono text-xs" placeholder="set priv-lvl = 15" value={a} onChange={e => onUpdateAction(si, ci, ai, e.target.value)} />
          ))}
          <button type="button" onClick={() => onAddAction(si, ci)} className="text-[10px] hover:underline" style={{ color: 'var(--s-muted)' }}>+ action</button>
        </div>
      )}
    </div>
  );
}
