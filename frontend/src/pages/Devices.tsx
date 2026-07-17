import { useState } from 'react';
import { Plus, Search, Wifi, WifiOff, HelpCircle, Pencil, Trash2, LayoutGrid, List, Key } from 'lucide-react';
import { api, ApiError, type Device, type DeviceGroup } from '../lib/api';
import { useApi, LoadState } from '../lib/useApi';
import Modal from '../components/Modal';
import RowMenu from '../components/RowMenu';

export default function Devices() {
  const { data, loading, error, reload } = useApi(api.getDevices);
  const groupsQuery = useApi(api.getDeviceGroups);
  const devices = data ?? [];
  const deviceGroups = groupsQuery.data ?? [];

  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [showAddModal, setShowAddModal] = useState(false);
  const [editDevice, setEditDevice] = useState<Device | null>(null);
  const [showGlobalKey, setShowGlobalKey] = useState(false);
  const [viewMode, setViewMode] = useState<'card' | 'list'>('card');
  const [actionError, setActionError] = useState<string | null>(null);

  const filtered = devices.filter(d => {
    const matchSearch = d.name.toLowerCase().includes(search.toLowerCase()) || d.address.includes(search);
    const matchStatus = filterStatus === 'all' || d.status === filterStatus;
    return matchSearch && matchStatus;
  });

  const commit = async (next: Device[]) => {
    setActionError(null);
    try {
      await api.saveDevices(next);
      await reload();
      await groupsQuery.reload(); // member counts change with devices
      return null;
    } catch (e) {
      const msg = e instanceof ApiError && e.validatorOutput
        ? `${e.message}\n${e.validatorOutput}`
        : e instanceof Error ? e.message : String(e);
      setActionError(msg);
      return msg;
    }
  };

  const removeDevice = async (name: string) => {
    if (!window.confirm(`Remove device "${name}"? The change is staged until you Commit in Edit Config mode.`)) return;
    await commit(devices.filter(d => d.name !== name));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold heading">Devices</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--s-muted)' }}>{devices.length} network devices (NAS)</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowGlobalKey(true)} className="btn-secondary flex items-center gap-2 text-sm">
            <Key className="w-4 h-4" /> Global Key
          </button>
          <button onClick={() => setShowAddModal(true)} className="btn-primary flex items-center gap-2">
            <Plus className="w-4 h-4" /> Add Device
          </button>
        </div>
      </div>

      {actionError && (
        <div className="glass-card p-4 border-l-2 border-red-500">
          <pre className="text-sm text-red-400 whitespace-pre-wrap">{actionError}</pre>
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--s-muted)' }} />
          <input type="text" placeholder="Search name or address..." value={search} onChange={e => setSearch(e.target.value)} className="input-field pl-10" />
        </div>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="select-field w-40">
          <option value="all">All Status</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="unknown">Unknown</option>
        </select>
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
            {filtered.map(device => <DeviceCard key={device.name} device={device} onEdit={setEditDevice} onRemove={removeDevice} />)}
          </div>
        ) : (
          <div className="glass-card overflow-x-auto">
            <table className="w-full min-w-[820px]">
              <thead>
                <tr style={{ backgroundColor: 'var(--s-bg)', opacity: 0.7 }}>
                  <th className="table-header">Status</th>
                  <th className="table-header">Name</th>
                  <th className="table-header">Address</th>
                  <th className="table-header">Platform</th>
                  <th className="table-header">Group</th>
                  <th className="table-header">Key</th>
                  <th className="table-header">Last Seen</th>
                  <th className="table-header w-12"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(device => <DeviceRow key={device.name} device={device} onEdit={setEditDevice} onRemove={removeDevice} />)}
              </tbody>
            </table>
          </div>
        )}

        {filtered.length === 0 && (
          <div className="glass-card py-12 text-center" style={{ color: 'var(--s-muted)' }}>No devices match the current filters.</div>
        )}
      </LoadState>

      <Modal open={showAddModal} onClose={() => setShowAddModal(false)} title="Add Device" maxWidth="max-w-2xl">
        <DeviceForm devices={devices} deviceGroups={deviceGroups} onCommit={commit} onClose={() => setShowAddModal(false)} />
      </Modal>

      <Modal open={!!editDevice} onClose={() => setEditDevice(null)} title="Edit Device" maxWidth="max-w-2xl">
        {editDevice && <DeviceForm devices={devices} deviceGroups={deviceGroups} onCommit={commit} onClose={() => setEditDevice(null)} initial={editDevice} />}
      </Modal>

      <Modal open={showGlobalKey} onClose={() => setShowGlobalKey(false)} title="Global TACACS+ Key">
        <div className="space-y-4">
          <p className="text-sm" style={{ color: 'var(--s-muted)' }}>
            The global key is used by all devices with key type <span className="font-mono text-xs heading">global</span>.
            It is provided to the server via the <span className="font-mono text-xs heading">TACACS_KEY</span> environment
            variable (server <span className="font-mono text-xs heading">.env</span>, sourced from OpenBao) and is not
            editable from the web UI - changing it requires a container restart so every global-key device picks it up.
          </p>
          <div className="flex justify-end pt-2">
            <button onClick={() => setShowGlobalKey(false)} className="btn-primary">Close</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function KeyBadge({ keyType }: { keyType: Device['keyType'] }) {
  const cls = keyType === 'custom' ? 'badge-admin' : keyType === 'group' ? 'badge-success' : 'badge-readonly';
  return <span className={cls}>{keyType}</span>;
}

// ---- Card view ----
function DeviceCard({ device, onEdit, onRemove }: { device: Device; onEdit: (d: Device) => void; onRemove: (name: string) => void }) {
  const StatusIcon = device.status === 'online' ? Wifi : device.status === 'offline' ? WifiOff : HelpCircle;
  const statusColor = device.status === 'online' ? 'text-emerald-400' : device.status === 'offline' ? 'text-red-400' : '';

  return (
    <div className="glass-card-hover p-5 relative">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <StatusIcon className={`w-5 h-5 ${statusColor}`} style={device.status === 'unknown' ? { color: 'var(--s-muted)' } : undefined} />
          <div>
            <h3 className="font-semibold font-mono text-sm heading">{device.name}</h3>
            <p className="text-xs font-mono" style={{ color: 'var(--s-muted)' }}>{device.address}</p>
          </div>
        </div>
        <RowMenu items={[
          { label: 'Edit', icon: Pencil, onClick: () => onEdit(device) },
          { label: 'Remove', icon: Trash2, onClick: () => onRemove(device.name), danger: true },
        ]} />
      </div>
      <div className="space-y-2 text-sm">
        <div className="flex justify-between"><span style={{ color: 'var(--s-muted)' }}>Platform</span><span style={{ color: 'var(--s-text)' }}>{device.platform || '-'}</span></div>
        <div className="flex justify-between"><span style={{ color: 'var(--s-muted)' }}>Group</span><span className="font-mono text-xs" style={{ color: 'var(--s-text)' }}>{device.group || '-'}</span></div>
        <div className="flex justify-between"><span style={{ color: 'var(--s-muted)' }}>Key</span><KeyBadge keyType={device.keyType} /></div>
        <div className="flex justify-between"><span style={{ color: 'var(--s-muted)' }}>Last Seen</span><span className="text-xs font-mono" style={{ color: 'var(--s-muted)' }}>{device.lastSeen}</span></div>
      </div>
    </div>
  );
}

// ---- List/Table view ----
function DeviceRow({ device, onEdit, onRemove }: { device: Device; onEdit: (d: Device) => void; onRemove: (name: string) => void }) {
  const statusColor = device.status === 'online' ? 'bg-emerald-400' : device.status === 'offline' ? 'bg-red-400' : 'bg-gray-400';

  return (
    <tr className="table-row">
      <td className="table-cell"><div className={`w-2.5 h-2.5 rounded-full ${statusColor}`} /></td>
      <td className="table-cell font-mono text-sm heading">{device.name}</td>
      <td className="table-cell font-mono text-xs" style={{ color: 'var(--s-muted)' }}>{device.address}</td>
      <td className="table-cell text-sm" style={{ color: 'var(--s-text)' }}>{device.platform || '-'}</td>
      <td className="table-cell font-mono text-xs" style={{ color: 'var(--s-text)' }}>{device.group || '-'}</td>
      <td className="table-cell"><KeyBadge keyType={device.keyType} /></td>
      <td className="table-cell font-mono text-xs" style={{ color: 'var(--s-muted)' }}>{device.lastSeen}</td>
      <td className="table-cell">
        <RowMenu items={[
          { label: 'Edit', icon: Pencil, onClick: () => onEdit(device) },
          { label: 'Remove', icon: Trash2, onClick: () => onRemove(device.name), danger: true },
        ]} />
      </td>
    </tr>
  );
}

// ---- Add/Edit form ----
function DeviceForm({ devices, deviceGroups, onCommit, onClose, initial }: {
  devices: Device[];
  deviceGroups: DeviceGroup[];
  onCommit: (next: Device[]) => Promise<string | null>;
  onClose: () => void;
  initial?: Device;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [address, setAddress] = useState(initial?.address ?? '');
  const [platform, setPlatform] = useState(initial?.platform ?? '');
  const [group, setGroup] = useState(initial?.group ?? '');
  const [keyType, setKeyType] = useState<Device['keyType']>(initial?.keyType ?? 'global');
  const [customKey, setCustomKey] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Leaving a group while inheriting its key falls back to the global key.
  const effectiveKeyType = keyType === 'group' && !group ? 'global' : keyType;

  const keyLine =
    effectiveKeyType === 'custom' ? `    key     = ${customKey ? `"${customKey}"` : '"<custom key>"'}\n` :
    effectiveKeyType === 'group' ? '' :
    '    key     = "${TACACS_KEY}"\n';
  const configPreview = name || address
    ? `device ${name || '<name>'} {\n    address = ${address || '<address>'}\n${group ? `    parent  = ${group}\n` : ''}${keyLine}}`
    : `# Fill in the fields to preview the config`;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!name.trim() || !address.trim()) {
      setFormError('Name and address are required.');
      return;
    }
    if (!initial && devices.some(d => d.name === name.trim())) {
      setFormError(`A device named "${name.trim()}" already exists.`);
      return;
    }
    if (effectiveKeyType === 'custom' && !initial && !customKey) {
      setFormError('A custom key value is required for new devices with key type custom.');
      return;
    }
    const entry: Device = {
      name: name.trim(),
      address: address.trim(),
      platform: platform.trim(),
      group: group || undefined,
      keyType: effectiveKeyType,
      // Empty key on edit keeps the existing custom key (agent behavior).
      key: effectiveKeyType === 'custom' && customKey ? customKey : undefined,
      lastSeen: initial?.lastSeen ?? '-',
      status: initial?.status ?? 'unknown',
    };
    const next = initial
      ? devices.map(d => (d.name === initial.name ? entry : d))
      : [...devices, entry];
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
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Device Name</label>
            <input type="text" className="input-field font-mono" placeholder="e.g. core-sw-03" value={name} onChange={e => setName(e.target.value)} disabled={!!initial} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Address (CIDR)</label>
            <input type="text" className="input-field font-mono" placeholder="e.g. 10.0.1.3/32" value={address} onChange={e => setAddress(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Platform</label>
            <input type="text" className="input-field" placeholder="e.g. Cisco IOS-XE, Juniper JunOS" value={platform} onChange={e => setPlatform(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Device Group</label>
            <select className="select-field" value={group} onChange={e => setGroup(e.target.value)}>
              <option value="">No group</option>
              {deviceGroups.map(g => <option key={g.name} value={g.name}>{g.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>TACACS+ Key</label>
            <select className="select-field" value={effectiveKeyType} onChange={e => setKeyType(e.target.value as Device['keyType'])}>
              <option value="global">Use Global Key</option>
              {group && <option value="group">Inherit Group Key</option>}
              <option value="custom">Custom Key</option>
            </select>
          </div>
          {effectiveKeyType === 'custom' && (
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Custom Key Value</label>
              <input type="password" className="input-field font-mono" placeholder={initial?.keyType === 'custom' ? 'Leave empty to keep current key' : 'Enter device-specific key'} value={customKey} onChange={e => setCustomKey(e.target.value)} />
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
        <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Committing…' : initial ? 'Save Changes' : 'Add Device'}</button>
      </div>
    </form>
  );
}
