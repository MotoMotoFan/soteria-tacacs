import { Plus, Users, Database, Cloud, LayoutGrid, List, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, type Group } from '../lib/api';
import { useApi, LoadState } from '../lib/useApi';
import Modal from '../components/Modal';
import RowMenu from '../components/RowMenu';

export default function Groups() {
  const { data, loading, error, reload } = useApi(api.getGroups);
  const groups = data ?? [];

  const [showAddModal, setShowAddModal] = useState(false);
  const [renameGroup, setRenameGroup] = useState<Group | null>(null);
  const [viewMode, setViewMode] = useState<'card' | 'list'>('card');
  const [actionError, setActionError] = useState<string | null>(null);

  const commit = async (next: Group[]) => {
    setActionError(null);
    try {
      await api.saveGroups(next);
      await reload();
      return null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setActionError(msg);
      return msg;
    }
  };

  const removeGroup = async (group: Group) => {
    if (group.members > 0) {
      setActionError(`Group "${group.name}" still has ${group.members} member(s) - reassign them before deleting (matches the server's "group remove" validation).`);
      return;
    }
    if (!window.confirm(`Remove group "${group.name}"?`)) return;
    await commit(groups.filter(g => g.name !== group.name));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold heading">Groups</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--s-muted)' }}>{groups.length} groups defined</p>
        </div>
        <button onClick={() => setShowAddModal(true)} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add Group
        </button>
      </div>

      {actionError && (
        <div className="glass-card p-4 border-l-2 border-red-500">
          <pre className="text-sm text-red-400 whitespace-pre-wrap">{actionError}</pre>
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--s-border)' }}>
          <button onClick={() => setViewMode('card')} className="p-2 transition-colors" style={{ backgroundColor: viewMode === 'card' ? 'var(--s-hover)' : 'transparent', color: viewMode === 'card' ? 'var(--s-heading)' : 'var(--s-muted)' }}>
            <LayoutGrid className="w-4 h-4" />
          </button>
          <button onClick={() => setViewMode('list')} className="p-2 transition-colors" style={{ backgroundColor: viewMode === 'list' ? 'var(--s-hover)' : 'transparent', color: viewMode === 'list' ? 'var(--s-heading)' : 'var(--s-muted)' }}>
            <List className="w-4 h-4" />
          </button>
        </div>
      </div>

      <LoadState loading={loading} error={error} onRetry={reload}>
        {viewMode === 'card' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {groups.map(group => (
              <GroupCard key={group.name} group={group} onRename={() => setRenameGroup(group)} onRemove={() => removeGroup(group)} />
            ))}
          </div>
        ) : (
          <div className="glass-card overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead>
                <tr style={{ backgroundColor: 'var(--s-bg)', opacity: 0.7 }}>
                  <th className="table-header">Source</th>
                  <th className="table-header">Name</th>
                  <th className="table-header">Members</th>
                  <th className="table-header">Profile</th>
                  <th className="table-header w-12"></th>
                </tr>
              </thead>
              <tbody>
                {groups.map(group => (
                  <tr key={group.name} className="table-row">
                    <td className="table-cell">
                      <span className={group.source === 'ldap' ? 'badge-readonly' : 'badge-admin'}>{group.source}</span>
                    </td>
                    <td className="table-cell font-mono text-sm heading">{group.name}</td>
                    <td className="table-cell heading">{group.members}</td>
                    <td className="table-cell font-mono text-sm" style={{ color: 'var(--s-text)' }}>{group.profile || '-'}</td>
                    <td className="table-cell">
                      <GroupMenu onRename={() => setRenameGroup(group)} onRemove={() => removeGroup(group)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </LoadState>

      <Modal open={showAddModal} onClose={() => setShowAddModal(false)} title="Add Group">
        <AddGroupForm groups={groups} onCommit={commit} onClose={() => setShowAddModal(false)} />
      </Modal>

      <Modal open={!!renameGroup} onClose={() => setRenameGroup(null)} title={`Rename Group - ${renameGroup?.name ?? ''}`}>
        {renameGroup && (
          <RenameGroupForm
            group={renameGroup}
            groups={groups}
            onCommit={commit}
            onClose={() => setRenameGroup(null)}
          />
        )}
      </Modal>
    </div>
  );
}

function GroupCard({ group, onRename, onRemove }: { group: Group; onRename: () => void; onRemove: () => void }) {
  return (
    <div className="glass-card-hover p-5">
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${group.source === 'ldap' ? 'bg-blue-500/15 text-blue-400' : 'bg-brand-purple/15 text-brand-magenta'}`}>
            {group.source === 'ldap' ? <Cloud className="w-5 h-5" /> : <Database className="w-5 h-5" />}
          </div>
          <div>
            <h3 className="font-semibold text-sm font-mono break-all heading">{group.name}</h3>
            <span className={group.source === 'ldap' ? 'badge-readonly' : 'badge-admin'}>{group.source}</span>
          </div>
        </div>
        <GroupMenu onRename={onRename} onRemove={onRemove} />
      </div>
      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="flex items-center gap-1.5" style={{ color: 'var(--s-muted)' }}><Users className="w-3.5 h-3.5" /> Members</span>
          <span className="font-medium heading">{group.members}</span>
        </div>
        <div className="flex justify-between">
          <span style={{ color: 'var(--s-muted)' }}>Mapped Profile</span>
          <span className="font-mono text-sm" style={{ color: 'var(--s-text)' }}>{group.profile || '-'}</span>
        </div>
      </div>
    </div>
  );
}

function GroupMenu({ onRename, onRemove }: { onRename: () => void; onRemove: () => void }) {
  return (
    <RowMenu items={[
      { label: 'Rename', icon: Pencil, onClick: onRename },
      { label: 'Remove', icon: Trash2, onClick: onRemove, danger: true },
    ]} />
  );
}

function AddGroupForm({ groups, onCommit, onClose }: {
  groups: Group[];
  onCommit: (next: Group[]) => Promise<string | null>;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [source, setSource] = useState<'local' | 'ldap'>('local');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!name.trim()) { setFormError('Group name is required.'); return; }
    if (groups.some(g => g.name === name.trim())) { setFormError(`Group "${name.trim()}" already exists.`); return; }
    setSaving(true);
    const err = await onCommit([...groups, { name: name.trim(), source, members: 0, profile: '' }]);
    setSaving(false);
    if (err) { setFormError(err); return; }
    onClose();
  };

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div>
        <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Group Name</label>
        <input type="text" className="input-field font-mono" placeholder="e.g. tacacs_operators" value={name} onChange={e => setName(e.target.value)} />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Source</label>
        <select className="select-field" value={source} onChange={e => setSource(e.target.value as 'local' | 'ldap')}>
          <option value="local">Local</option>
          <option value="ldap">LDAP</option>
        </select>
      </div>
      {formError && <p className="text-sm text-red-400">{formError}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
        <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Committing…' : 'Create Group'}</button>
      </div>
    </form>
  );
}

function RenameGroupForm({ group, groups, onCommit, onClose }: {
  group: Group;
  groups: Group[];
  onCommit: (next: Group[]) => Promise<string | null>;
  onClose: () => void;
}) {
  const [name, setName] = useState(group.name);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const trimmed = name.trim();
    if (!trimmed) { setFormError('Group name is required.'); return; }
    if (trimmed !== group.name && groups.some(g => g.name === trimmed)) {
      setFormError(`Group "${trimmed}" already exists.`);
      return;
    }
    setSaving(true);
    const err = await onCommit(groups.map(g => (g.name === group.name ? { ...g, name: trimmed } : g)));
    setSaving(false);
    if (err) { setFormError(err); return; }
    onClose();
  };

  return (
    <form className="space-y-4" onSubmit={submit}>
      <p className="text-xs" style={{ color: 'var(--s-muted)' }}>
        Note: renaming only changes the group definition - users referencing the old name and ruleset
        conditions must be updated separately.
      </p>
      <div>
        <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Group Name</label>
        <input type="text" className="input-field font-mono" value={name} onChange={e => setName(e.target.value)} />
      </div>
      {formError && <p className="text-sm text-red-400">{formError}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
        <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Committing…' : 'Rename'}</button>
      </div>
    </form>
  );
}
