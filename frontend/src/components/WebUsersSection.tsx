import { useCallback, useEffect, useState, FormEvent } from 'react';
import { User } from '@supabase/supabase-js';
import { UserPlus, Pencil, Trash2, ShieldCheck, ShieldOff, Loader2, AlertCircle, Users as UsersIcon } from 'lucide-react';
import { supabaseAdmin } from '../lib/supabase';
import { useAuth } from './AuthProvider';
import Modal from './Modal';
import { api } from '../lib/api';
import { listRoles, appMetadataForGroup, ensureProtectedRoles, ADMIN_GROUP, READONLY_GROUP, type WebRole } from '../lib/roles';

interface WebUserForm {
  email: string;
  password: string;
  fullName: string;
  group: string; // access group name; membership fully determines access
}

const emptyForm: WebUserForm = { email: '', password: '', fullName: '', group: READONLY_GROUP };

export default function WebUsersSection() {
  const { user: currentUser, isAdmin } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  // listUsers() does not include factors, so MFA state is fetched per user.
  const [mfaFactorIds, setMfaFactorIds] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);

  const loadUsers = useCallback(async () => {
    if (!supabaseAdmin) return;
    setLoading(true);
    // Make sure the protected Administrator + Read Only groups exist.
    try { await ensureProtectedRoles((await api.listApiScopes()).map((s) => s.scope)); } catch { /* non-fatal */ }
    const { data, error: listError } = await supabaseAdmin.auth.admin.listUsers();
    if (listError) {
      setError(listError.message);
    } else {
      setError(null);
      setUsers(data.users);
      const entries = await Promise.all(data.users.map(async (u) => {
        const { data: fData } = await supabaseAdmin!.auth.admin.mfa.listFactors({ userId: u.id });
        return [u.id, (fData?.factors ?? []).map((f) => f.id)] as const;
      }));
      setMfaFactorIds(Object.fromEntries(entries));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (isAdmin && supabaseAdmin) loadUsers();
  }, [isAdmin, loadUsers]);

  if (!isAdmin || !supabaseAdmin) return null;

  const handleDelete = async (u: User) => {
    if (!window.confirm(`Delete web user ${u.email}? This cannot be undone.`)) return;
    const { error: delError } = await supabaseAdmin!.auth.admin.deleteUser(u.id);
    if (delError) setError(delError.message);
    else loadUsers();
  };

  const openAdd = () => { setEditing(null); setModalOpen(true); };
  const openEdit = (u: User) => { setEditing(u); setModalOpen(true); };

  const handleResetMfa = async (u: User) => {
    if (!window.confirm(`Reset two-factor authentication for ${u.email}? They will sign in with password only until they re-enroll.`)) return;
    for (const factorId of mfaFactorIds[u.id] ?? []) {
      const { error: mfaError } = await supabaseAdmin!.auth.admin.mfa.deleteFactor({ id: factorId, userId: u.id });
      if (mfaError) { setError(mfaError.message); return; }
    }
    loadUsers();
  };

  return (
    <>
    {/* Modal must stay outside the glass-card: its backdrop-filter turns the card
        into the containing block for position:fixed, trapping the overlay. */}
    <div className="glass-card p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-brand-purple/15 flex items-center justify-center">
            <UsersIcon className="w-[18px] h-[18px] text-brand-magenta" />
          </div>
          <div>
            <h3 className="text-base font-semibold heading">Web UI Users</h3>
            <p className="text-xs" style={{ color: 'var(--s-muted)' }}>Accounts that can sign in to this management UI (Supabase Auth)</p>
          </div>
        </div>
        <button onClick={openAdd} className="btn-primary flex items-center gap-2 text-sm">
          <UserPlus className="w-4 h-4" /> Add User
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 px-3 py-2.5 mb-4 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="w-6 h-6 animate-spin text-brand-magenta" />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr>
                <th className="table-header">Email</th>
                <th className="table-header">Name</th>
                <th className="table-header">Role</th>
                <th className="table-header">Last Sign In</th>
                <th className="table-header text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const meta = (u.app_metadata as { role?: string; group?: string });
                const group = meta?.group ?? (meta?.role === 'admin' ? ADMIN_GROUP : undefined);
                const isSelf = u.id === currentUser?.id;
                return (
                  <tr key={u.id} className="table-row">
                    <td className="table-cell font-medium" style={{ color: 'var(--s-text)' }}>
                      {u.email}
                      {isSelf && <span className="text-xs ml-2" style={{ color: 'var(--s-muted)' }}>(you)</span>}
                    </td>
                    <td className="table-cell">{(u.user_metadata as { full_name?: string })?.full_name ?? '-'}</td>
                    <td className="table-cell">
                      {group === ADMIN_GROUP
                        ? <span className="badge-admin"><ShieldCheck className="w-3 h-3 mr-1" /> {ADMIN_GROUP}</span>
                        : group
                          ? <span className="badge-success">{group}</span>
                          : <span className="badge-warning" title="No group: this user has no API access">no group</span>}
                    </td>
                    <td className="table-cell" style={{ color: 'var(--s-muted)' }}>
                      {u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString() : 'never'}
                    </td>
                    <td className="table-cell text-right">
                      <div className="flex items-center justify-end gap-1">
                        {(mfaFactorIds[u.id]?.length ?? 0) > 0 && (
                          <button onClick={() => handleResetMfa(u)} className="btn-ghost p-1.5 hover:text-amber-400" title="Reset MFA (removes enrolled authenticator)">
                            <ShieldOff className="w-4 h-4" />
                          </button>
                        )}
                        <button onClick={() => openEdit(u)} className="btn-ghost p-1.5" title="Edit user">
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(u)}
                          disabled={isSelf}
                          className="btn-ghost p-1.5 disabled:opacity-30 disabled:cursor-not-allowed hover:text-red-400"
                          title={isSelf ? 'You cannot delete your own account' : 'Delete user'}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
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

    <WebUserModal
      open={modalOpen}
      editing={editing}
      onClose={() => setModalOpen(false)}
      onSaved={() => { setModalOpen(false); loadUsers(); }}
    />
    </>
  );
}

function WebUserModal({ open, editing, onClose, onSaved }: {
  open: boolean; editing: User | null; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState<WebUserForm>(emptyForm);
  const [roles, setRoles] = useState<WebRole[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    listRoles().then(setRoles).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    if (editing) {
      const meta = editing.app_metadata as { role?: string; group?: string };
      setForm({
        email: editing.email ?? '',
        password: '',
        fullName: (editing.user_metadata as { full_name?: string })?.full_name ?? '',
        group: meta?.group ?? (meta?.role === 'admin' ? ADMIN_GROUP : READONLY_GROUP),
      });
    } else {
      setForm(emptyForm);
    }
  }, [open, editing]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!supabaseAdmin) return;
    setSaving(true);
    setError(null);

    const groupScopes = roles.find((r) => r.name === form.group)?.scopes ?? [];
    const app_metadata = appMetadataForGroup(form.group, groupScopes);

    if (editing) {
      const { error: updError } = await supabaseAdmin.auth.admin.updateUserById(editing.id, {
        email: form.email,
        ...(form.password ? { password: form.password } : {}),
        user_metadata: { full_name: form.fullName },
        app_metadata,
      });
      setSaving(false);
      if (updError) return setError(updError.message);
    } else {
      const { error: createError } = await supabaseAdmin.auth.admin.createUser({
        email: form.email,
        password: form.password,
        email_confirm: true,
        user_metadata: { full_name: form.fullName },
        app_metadata,
      });
      setSaving(false);
      if (createError) return setError(createError.message);
    }
    onSaved();
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? `Edit ${editing.email}` : 'Add Web User'}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
            <AlertCircle className="w-4 h-4 shrink-0" /> {error}
          </div>
        )}

        <div>
          <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Email</label>
          <input
            type="email" required value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="input-field" placeholder="user@soteria.lab"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Full Name</label>
          <input
            type="text" value={form.fullName}
            onChange={(e) => setForm({ ...form, fullName: e.target.value })}
            className="input-field" placeholder="Jane Doe"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>
            {editing ? 'New Password (leave blank to keep current)' : 'Password'}
          </label>
          <input
            type="password" required={!editing} minLength={8} value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="input-field" placeholder="Minimum 8 characters"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Group</label>
          <select
            value={form.group}
            onChange={(e) => setForm({ ...form, group: e.target.value })}
            className="select-field"
          >
            <option value="">No group (no access)</option>
            {roles.map((r) => <option key={r.id} value={r.name}>{r.name}</option>)}
          </select>
          <p className="text-xs mt-1.5" style={{ color: 'var(--s-muted)' }}>
            The group fully determines access: <span className="font-medium heading">{ADMIN_GROUP}</span> = full admin,{' '}
            <span className="font-medium heading">{READONLY_GROUP}</span> = read-only everywhere. Manage groups in Access Groups.
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary flex items-center gap-2">
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {editing ? 'Save Changes' : 'Create User'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
