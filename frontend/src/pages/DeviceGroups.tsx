import { useState } from 'react';
import { Plus, Boxes, Server, Pencil, Trash2, LayoutGrid, List, Key } from 'lucide-react';
import { api, ApiError, type DeviceGroup } from '../lib/api';
import { useApi, LoadState } from '../lib/useApi';
import Modal from '../components/Modal';
import RowMenu from '../components/RowMenu';

export default function DeviceGroups() {
  const { data, loading, error, reload } = useApi(api.getDeviceGroups);
  const groups = data ?? [];

  const [showAddModal, setShowAddModal] = useState(false);
  const [editGroup, setEditGroup] = useState<DeviceGroup | null>(null);
  const [viewMode, setViewMode] = useState<'card' | 'list'>('card');
  const [actionError, setActionError] = useState<string | null>(null);

  const commit = async (next: DeviceGroup[]) => {
    setActionError(null);
    try {
      await api.saveDeviceGroups(next);
      await reload();
      return null;
    } catch (e) {
      const msg = e instanceof ApiError && e.validatorOutput
        ? `${e.message}\n${e.validatorOutput}`
        : e instanceof Error ? e.message : String(e);
      setActionError(msg);
      return msg;
    }
  };

  const removeGroup = async (group: DeviceGroup) => {
    if (group.members > 0) {
      setActionError(`Device group "${group.name}" still has ${group.members} member device(s) - reassign them before deleting.`);
      return;
    }
    if (!window.confirm(`Remove device group "${group.name}"? The change is staged until you Commit in Edit Config mode.`)) return;
    await commit(groups.filter(g => g.name !== group.name));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold heading">Device Groups</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--s-muted)' }}>
            {groups.length} groups - member devices inherit the group's TACACS+ key and settings
          </p>
        </div>
        <button onClick={() => setShowAddModal(true)} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add Device Group
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
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {groups.map(group => (
              <GroupCard key={group.name} group={group} onEdit={() => setEditGroup(group)} onRemove={() => removeGroup(group)} />
            ))}
          </div>
        ) : (
          <div className="glass-card overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead>
                <tr style={{ backgroundColor: 'var(--s-bg)', opacity: 0.7 }}>
                  <th className="table-header">Name</th>
                  <th className="table-header">Description</th>
                  <th className="table-header">Key</th>
                  <th className="table-header">Member Devices</th>
                  <th className="table-header w-12"></th>
                </tr>
              </thead>
              <tbody>
                {groups.map(group => (
                  <tr key={group.name} className="table-row">
                    <td className="table-cell font-mono text-sm heading">{group.name}</td>
                    <td className="table-cell text-sm" style={{ color: 'var(--s-muted)' }}>{group.description || '-'}</td>
                    <td className="table-cell"><span className={group.keyType === 'custom' ? 'badge-admin' : 'badge-readonly'}>{group.keyType}</span></td>
                    <td className="table-cell heading">{group.members}</td>
                    <td className="table-cell">
                      <RowMenu items={[
                        { label: 'Edit', icon: Pencil, onClick: () => setEditGroup(group) },
                        { label: 'Remove', icon: Trash2, onClick: () => removeGroup(group), danger: true },
                      ]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {groups.length === 0 && (
          <div className="glass-card py-12 text-center space-y-2">
            <p style={{ color: 'var(--s-muted)' }}>No device groups yet.</p>
            <p className="text-xs" style={{ color: 'var(--s-muted)', opacity: 0.7 }}>
              Create a group to share a TACACS+ key across devices (e.g. core-switches, branch-routers) - devices join it from the device form.
            </p>
          </div>
        )}
      </LoadState>

      <Modal open={showAddModal} onClose={() => setShowAddModal(false)} title="Add Device Group" maxWidth="max-w-2xl">
        <GroupForm groups={groups} onCommit={commit} onClose={() => setShowAddModal(false)} />
      </Modal>

      <Modal open={!!editGroup} onClose={() => setEditGroup(null)} title="Edit Device Group" maxWidth="max-w-2xl">
        {editGroup && <GroupForm groups={groups} onCommit={commit} onClose={() => setEditGroup(null)} initial={editGroup} />}
      </Modal>
    </div>
  );
}

function GroupCard({ group, onEdit, onRemove }: { group: DeviceGroup; onEdit: () => void; onRemove: () => void }) {
  return (
    <div className="glass-card-hover p-5">
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-brand-purple/15 text-brand-magenta flex items-center justify-center">
            <Boxes className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-semibold text-sm font-mono heading">{group.name}</h3>
            {group.description && <p className="text-xs" style={{ color: 'var(--s-muted)' }}>{group.description}</p>}
          </div>
        </div>
        <RowMenu items={[
          { label: 'Edit', icon: Pencil, onClick: onEdit },
          { label: 'Remove', icon: Trash2, onClick: onRemove, danger: true },
        ]} />
      </div>
      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="flex items-center gap-1.5" style={{ color: 'var(--s-muted)' }}><Key className="w-3.5 h-3.5" /> Key</span>
          <span className={group.keyType === 'custom' ? 'badge-admin' : 'badge-readonly'}>{group.keyType}</span>
        </div>
        <div className="flex justify-between">
          <span className="flex items-center gap-1.5" style={{ color: 'var(--s-muted)' }}><Server className="w-3.5 h-3.5" /> Member Devices</span>
          <span className="font-medium heading">{group.members}</span>
        </div>
      </div>
    </div>
  );
}

function GroupForm({ groups, onCommit, onClose, initial }: {
  groups: DeviceGroup[];
  onCommit: (next: DeviceGroup[]) => Promise<string | null>;
  onClose: () => void;
  initial?: DeviceGroup;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [keyType, setKeyType] = useState<'global' | 'custom'>(initial?.keyType ?? 'custom');
  const [customKey, setCustomKey] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const configPreview = name
    ? `device ${name} {\n${description ? `    # @description ${description}\n` : ''}    key = ${keyType === 'custom' ? (customKey ? `"${customKey}"` : '"<group key>"') : '"${TACACS_KEY}"'}\n}\n\n# members reference it:\ndevice <member> {\n    address = <cidr>\n    parent  = ${name}\n}`
    : '# Fill in the fields to preview the config';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const trimmed = name.trim();
    if (!trimmed) { setFormError('Group name is required.'); return; }
    if (!initial && groups.some(g => g.name === trimmed)) { setFormError(`Device group "${trimmed}" already exists.`); return; }
    if (keyType === 'custom' && !initial && !customKey) { setFormError('A key value is required for new groups with a custom key.'); return; }
    const entry: DeviceGroup = {
      name: trimmed,
      description: description.trim() || undefined,
      keyType,
      // Empty key on edit keeps the existing one (agent behavior).
      key: keyType === 'custom' && customKey ? customKey : undefined,
      members: initial?.members ?? 0,
    };
    const next = initial ? groups.map(g => (g.name === initial.name ? entry : g)) : [...groups, entry];
    setSaving(true);
    const err = await onCommit(next);
    setSaving(false);
    if (err) { setFormError(err); return; }
    onClose();
  };

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Group Name</label>
            <input type="text" className="input-field font-mono" placeholder="e.g. core-switches" value={name} onChange={e => setName(e.target.value)} disabled={!!initial} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Description</label>
            <input type="text" className="input-field" placeholder="e.g. Datacenter core layer" value={description} onChange={e => setDescription(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>TACACS+ Key</label>
            <select className="select-field" value={keyType} onChange={e => setKeyType(e.target.value as 'global' | 'custom')}>
              <option value="custom">Group-specific Key</option>
              <option value="global">Use Global Key</option>
            </select>
          </div>
          {keyType === 'custom' && (
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Key Value</label>
              <input type="password" className="input-field font-mono" placeholder={initial?.keyType === 'custom' ? 'Leave empty to keep current key' : 'Enter group key'} value={customKey} onChange={e => setCustomKey(e.target.value)} />
            </div>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-muted)' }}>Config Preview</label>
          <pre className="config-preview min-h-[200px] whitespace-pre">{configPreview}</pre>
        </div>
      </div>
      {formError && <p className="text-sm text-red-400">{formError}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
        <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Committing…' : initial ? 'Save Changes' : 'Create Group'}</button>
      </div>
    </form>
  );
}
