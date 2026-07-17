import { useState } from 'react';
import { Plus, Search, UserCheck, UserX, Key } from 'lucide-react';
import { api, ApiError, type User } from '../lib/api';
import { useApi, LoadState } from '../lib/useApi';
import Modal from '../components/Modal';
import RowMenu from '../components/RowMenu';

export default function Users() {
  const { data, loading, error, reload } = useApi(api.getUsers);
  const groupsQuery = useApi(api.getGroups);
  const users = data ?? [];
  const groups = groupsQuery.data ?? [];

  const [search, setSearch] = useState('');
  const [filterGroup, setFilterGroup] = useState('all');
  const [showAddModal, setShowAddModal] = useState(false);
  const [passwordUser, setPasswordUser] = useState<User | null>(null);
  const [groupUser, setGroupUser] = useState<User | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const filtered = users.filter(u => {
    const matchSearch = u.name.toLowerCase().includes(search.toLowerCase());
    const matchGroup = filterGroup === 'all' || u.group === filterGroup;
    return matchSearch && matchGroup;
  });

  const commit = async (next: User[]) => {
    setActionError(null);
    try {
      await api.saveUsers(next);
      await reload();
      await groupsQuery.reload(); // member counts change with users
      return null;
    } catch (e) {
      const msg = e instanceof ApiError && e.validatorOutput
        ? `${e.message}\n${e.validatorOutput}`
        : e instanceof Error ? e.message : String(e);
      setActionError(msg);
      return msg;
    }
  };

  const removeUser = async (name: string) => {
    if (!window.confirm(`Remove local user "${name}"? The change is staged until you Commit in Edit Config mode.`)) return;
    await commit(users.filter(u => u.name !== name));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold heading">Users</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--s-muted)' }}>{users.length} local users configured</p>
        </div>
        <button onClick={() => setShowAddModal(true)} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add User
        </button>
      </div>

      {actionError && (
        <div className="glass-card p-4 border-l-2 border-red-500">
          <pre className="text-sm text-red-400 whitespace-pre-wrap">{actionError}</pre>
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--s-muted)' }} />
          <input type="text" placeholder="Search users..." value={search} onChange={e => setSearch(e.target.value)} className="input-field pl-10" />
        </div>
        <select value={filterGroup} onChange={e => setFilterGroup(e.target.value)} className="select-field w-48">
          <option value="all">All Groups</option>
          {groups.map(g => <option key={g.name} value={g.name}>{g.name}</option>)}
        </select>
      </div>

      <LoadState loading={loading} error={error} onRetry={reload}>
        <div className="glass-card overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr style={{ backgroundColor: 'var(--s-bg)', opacity: 0.7 }}>
                <th className="table-header">Username</th>
                <th className="table-header">Group</th>
                <th className="table-header">Source</th>
                <th className="table-header">Status</th>
                <th className="table-header">Last Login</th>
                <th className="table-header w-12"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(user => (
                <UserRow
                  key={user.name}
                  user={user}
                  onSetPassword={() => setPasswordUser(user)}
                  onChangeGroup={() => setGroupUser(user)}
                  onRemove={() => removeUser(user.name)}
                />
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="py-12 text-center" style={{ color: 'var(--s-muted)' }}>No users match the current filters.</div>
          )}
        </div>
      </LoadState>

      <Modal open={showAddModal} onClose={() => setShowAddModal(false)} title="Add User" maxWidth="max-w-2xl">
        <AddUserForm users={users} groups={groups.map(g => g.name)} onCommit={commit} onClose={() => setShowAddModal(false)} />
      </Modal>

      <Modal open={!!passwordUser} onClose={() => setPasswordUser(null)} title={`Set Password - ${passwordUser?.name ?? ''}`}>
        {passwordUser && (
          <SetPasswordForm
            onClose={() => setPasswordUser(null)}
            onSubmit={async password =>
              commit(users.map(u => (u.name === passwordUser.name ? { ...u, password } : u)))
            }
          />
        )}
      </Modal>

      <Modal open={!!groupUser} onClose={() => setGroupUser(null)} title={`Change Group - ${groupUser?.name ?? ''}`}>
        {groupUser && (
          <ChangeGroupForm
            current={groupUser.group}
            groups={groups.map(g => g.name)}
            onClose={() => setGroupUser(null)}
            onSubmit={async group =>
              commit(users.map(u => (u.name === groupUser.name ? { ...u, group } : u)))
            }
          />
        )}
      </Modal>
    </div>
  );
}

function UserRow({ user, onSetPassword, onChangeGroup, onRemove }: {
  user: User;
  onSetPassword: () => void;
  onChangeGroup: () => void;
  onRemove: () => void;
}) {
  return (
    <tr className="table-row">
      <td className="table-cell">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-brand-purple/15 flex items-center justify-center">
            <span className="text-xs font-bold text-brand-magenta">{user.name.slice(0, 2).toUpperCase()}</span>
          </div>
          <span className="font-medium font-mono text-sm heading">{user.name}</span>
        </div>
      </td>
      <td className="table-cell">
        <span className={user.group === 'tacacs_admin' ? 'badge-admin' : 'badge-readonly'}>{user.group || '-'}</span>
      </td>
      <td className="table-cell">
        <span className="text-sm uppercase tracking-wide" style={{ color: 'var(--s-muted)' }}>{user.authSource}</span>
      </td>
      <td className="table-cell">
        <span className={
          user.status === 'active' ? 'badge-success' :
          user.status === 'locked' ? 'badge-danger' : 'badge-warning'
        }>{user.status}</span>
      </td>
      <td className="table-cell font-mono text-xs" style={{ color: 'var(--s-muted)' }}>{user.lastLogin}</td>
      <td className="table-cell">
        <RowMenu items={[
          { label: 'Set Password', icon: Key, onClick: onSetPassword },
          { label: 'Change Group', icon: UserCheck, onClick: onChangeGroup },
          { label: 'Remove User', icon: UserX, onClick: onRemove, danger: true },
        ]} />
      </td>
    </tr>
  );
}

function AddUserForm({ users, groups, onCommit, onClose }: {
  users: User[];
  groups: string[];
  onCommit: (next: User[]) => Promise<string | null>;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [group, setGroup] = useState(groups[0] ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const configPreview = `user ${name || '<name>'} {
    password login = crypt "<sha-512 hash>"
    password pap   = login
    member         = ${group || '<group>'}
}`;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!name.trim()) { setFormError('Username is required.'); return; }
    if (users.some(u => u.name === name.trim())) { setFormError(`User "${name.trim()}" already exists.`); return; }
    if (!password) { setFormError('Password is required.'); return; }
    if (password !== confirm) { setFormError('Passwords do not match.'); return; }
    const entry: User = {
      name: name.trim(),
      group,
      authSource: 'local',
      lastLogin: '-',
      status: 'active',
      password,
    };
    setSaving(true);
    const err = await onCommit([...users, entry]);
    setSaving(false);
    if (err) { setFormError(err); return; }
    onClose();
  };

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Username</label>
            <input type="text" className="input-field font-mono" placeholder="e.g. john_doe" value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Group</label>
            <select className="select-field" value={group} onChange={e => setGroup(e.target.value)}>
              {groups.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Password</label>
            <input type="password" className="input-field" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Confirm Password</label>
            <input type="password" className="input-field" placeholder="••••••••" value={confirm} onChange={e => setConfirm(e.target.value)} />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-muted)' }}>Config Preview</label>
          <pre className="config-preview min-h-[160px] whitespace-pre">{configPreview}</pre>
        </div>
      </div>

      {formError && <p className="text-sm text-red-400">{formError}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
        <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Committing…' : 'Create User'}</button>
      </div>
    </form>
  );
}

function SetPasswordForm({ onSubmit, onClose }: {
  onSubmit: (password: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!password) { setFormError('Password is required.'); return; }
    if (password !== confirm) { setFormError('Passwords do not match.'); return; }
    setSaving(true);
    const err = await onSubmit(password);
    setSaving(false);
    if (err) { setFormError(err); return; }
    onClose();
  };

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div>
        <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>New Password</label>
        <input type="password" className="input-field" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Confirm Password</label>
        <input type="password" className="input-field" placeholder="••••••••" value={confirm} onChange={e => setConfirm(e.target.value)} />
      </div>
      {formError && <p className="text-sm text-red-400">{formError}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
        <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Committing…' : 'Set Password'}</button>
      </div>
    </form>
  );
}

function ChangeGroupForm({ current, groups, onSubmit, onClose }: {
  current: string;
  groups: string[];
  onSubmit: (group: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [group, setGroup] = useState(current);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSaving(true);
    const err = await onSubmit(group);
    setSaving(false);
    if (err) { setFormError(err); return; }
    onClose();
  };

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div>
        <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Group</label>
        <select className="select-field" value={group} onChange={e => setGroup(e.target.value)}>
          {groups.map(g => <option key={g} value={g}>{g}</option>)}
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
