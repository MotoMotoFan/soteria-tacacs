import { useEffect, useState } from 'react';
import { ShieldCheck, Plus, Pencil, Trash2, Loader2, AlertCircle, Lock } from 'lucide-react';
import { api, type ApiScope } from '../lib/api';
import { useAuth } from './AuthProvider';
import Modal from './Modal';
import ScopeMatrix from './ScopeMatrix';
import { listRoles, createRole, updateRole, deleteRole, isProtectedGroup, ensureProtectedRoles, type WebRole } from '../lib/roles';

// Access Groups = web-UI permission roles. Admin defines a group + scopes;
// users assigned to it inherit those scopes (see WebUsersSection). Distinct from
// the TACACS "User Groups" page.
export default function RolesSection() {
  const { isAdmin } = useAuth();
  const [roles, setRoles] = useState<WebRole[]>([]);
  const [scopes, setScopes] = useState<ApiScope[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<WebRole | null>(null);

  const load = async () => {
    setError(null);
    try {
      const s = await api.listApiScopes();
      setScopes(s);
      try { await ensureProtectedRoles(s.map((x) => x.scope)); } catch { /* concurrent seed / non-fatal */ }
      setRoles(await listRoles());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (isAdmin) void load(); }, [isAdmin]);

  if (!isAdmin) return null;

  const remove = async (role: WebRole) => {
    if (!window.confirm(`Delete access group "${role.name}"? Members will be left with no group (no access until reassigned).`)) return;
    try {
      await deleteRole(role.id, role.name);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <div className="glass-card p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-brand-purple/15 flex items-center justify-center shrink-0">
              <ShieldCheck className="w-[18px] h-[18px] text-brand-magenta" />
            </div>
            <div>
              <h3 className="text-base font-semibold heading">Access Groups</h3>
              <p className="text-xs" style={{ color: 'var(--s-muted)' }}>
                Permission roles for web users. Assign a group to a user under Web UI Users. (Not the TACACS User Groups.)
              </p>
            </div>
          </div>
          <button onClick={() => { setEditing(null); setModalOpen(true); }} className="btn-primary flex items-center gap-2 text-sm">
            <Plus className="w-4 h-4" /> New Group
          </button>
        </div>

        {error && (
          <div className="flex items-center gap-2 px-3 py-2.5 mb-4 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
            <AlertCircle className="w-4 h-4 shrink-0" /> {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-brand-magenta" /></div>
        ) : roles.length === 0 ? (
          <div className="py-10 text-center text-sm" style={{ color: 'var(--s-muted)' }}>
            No access groups yet. Admins have full access; create a group to grant scoped access to non-admin users.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead>
                <tr>
                  <th className="table-header">Group</th>
                  <th className="table-header">Scopes</th>
                  <th className="table-header text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {roles.map((r) => {
                  const locked = isProtectedGroup(r.name);
                  return (
                    <tr key={r.id} className="table-row">
                      <td className="table-cell font-medium heading">
                        {r.name}
                        {locked && <span className="badge-readonly ml-2" title="Built-in protected group"><Lock className="w-3 h-3 mr-1" /> protected</span>}
                      </td>
                      <td className="table-cell">
                        <div className="flex flex-wrap gap-1 max-w-lg">
                          {r.name === 'Administrator'
                            ? <span className="badge-admin text-[10px]">full access</span>
                            : <>
                                {r.scopes.length === 0 && <span className="text-xs" style={{ color: 'var(--s-muted)' }}>none</span>}
                                {r.scopes.slice(0, 8).map((s) => <span key={s} className="badge-readonly font-mono text-[10px]">{s}</span>)}
                                {r.scopes.length > 8 && <span className="text-xs" style={{ color: 'var(--s-muted)' }}>+{r.scopes.length - 8}</span>}
                              </>}
                        </div>
                      </td>
                      <td className="table-cell text-right">
                        <div className="flex items-center justify-end gap-1">
                          {locked ? (
                            <span className="text-xs" style={{ color: 'var(--s-muted)' }}>—</span>
                          ) : (
                            <>
                              <button onClick={() => { setEditing(r); setModalOpen(true); }} className="btn-ghost p-1.5" title="Edit group"><Pencil className="w-4 h-4" /></button>
                              <button onClick={() => remove(r)} className="btn-ghost p-1.5 hover:text-red-400" title="Delete group"><Trash2 className="w-4 h-4" /></button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <RoleModal
        open={modalOpen}
        editing={editing}
        scopes={scopes}
        onClose={() => setModalOpen(false)}
        onSaved={() => { setModalOpen(false); void load(); }}
      />
    </>
  );
}

function RoleModal({ open, editing, scopes, onClose, onSaved }: {
  open: boolean; editing: WebRole | null; scopes: ApiScope[]; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(editing?.name ?? '');
    setSelected(new Set(editing?.scopes ?? []));
  }, [open, editing]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (!name.trim()) throw new Error('Group name is required.');
      if (editing) await updateRole(editing.id, editing.name, name, [...selected]);
      else await createRole(name, [...selected]);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? `Edit group "${editing.name}"` : 'New Access Group'} maxWidth="max-w-2xl">
      <div className="space-y-4">
        {error && (
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
            <AlertCircle className="w-4 h-4 shrink-0" /> {error}
          </div>
        )}
        <div>
          <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Group name</label>
          <input className="input-field" placeholder="e.g. Read Only, Device Operators" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium" style={{ color: 'var(--s-text)' }}>Scopes ({selected.size} selected)</label>
            <span className="text-xs" style={{ color: 'var(--s-muted)' }}>Members can only call endpoints matching these scopes.</span>
          </div>
          <ScopeMatrix scopes={scopes} selected={selected} onChange={setSelected} />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={save} disabled={saving || !name.trim()} className="btn-primary flex items-center gap-2">
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {editing ? 'Save changes' : 'Create group'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
