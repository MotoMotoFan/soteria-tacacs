import { useEffect } from 'react';
import {
  Users, Server, ShieldCheck, Activity, AlertTriangle,
  Clock, Lock, Wifi, ArrowUpRight,
} from 'lucide-react';
import { api, type LogEntry } from '../lib/api';
import { useApi } from '../lib/useApi';
import AuthActivityChart from '../components/AuthActivityChart';
import { useNavigate } from 'react-router-dom';

function StatCard({ icon: Icon, label, value, sub, color, onClick }: {
  icon: React.ElementType; label: string; value: string | number; sub?: string; color: string; onClick?: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className="stat-card group text-left w-full cursor-pointer">
      <div className="flex items-start justify-between mb-3">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${color}`}>
          <Icon className="w-5 h-5" />
        </div>
        <ArrowUpRight className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: 'var(--s-muted)' }} />
      </div>
      <p className="text-2xl font-bold heading">{value}</p>
      <p className="text-sm mt-1" style={{ color: 'var(--s-muted)' }}>{label}</p>
      {sub && <p className="text-xs mt-0.5" style={{ color: 'var(--s-muted)', opacity: 0.7 }}>{sub}</p>}
    </button>
  );
}

const AAA_TYPES = [
  { type: 'authentication', label: 'Authentication', dot: 'bg-brand-magenta' },
  { type: 'authorization', label: 'Authorization', dot: 'bg-blue-400' },
  { type: 'accounting', label: 'Accounting', dot: 'bg-emerald-400' },
] as const;

function AaaCountsCard({ logs, onOpenLogs }: { logs: LogEntry[]; onOpenLogs: () => void }) {
  return (
    <div className="glass-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold heading">AAA Events Today</h3>
        <button onClick={onOpenLogs} className="text-xs text-brand-magenta hover:text-brand-pink transition-colors">View logs →</button>
      </div>
      <div className="space-y-3">
        {AAA_TYPES.map(({ type, label, dot }) => (
          <div key={type} className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${dot}`} />
              <span className="text-sm" style={{ color: 'var(--s-text)' }}>{label}</span>
            </div>
            <span className="text-sm font-mono font-semibold heading">{logs.filter(l => l.type === type).length}</span>
          </div>
        ))}
        <div className="flex items-center justify-between pt-2" style={{ borderTop: '1px solid var(--s-border)' }}>
          <span className="text-sm" style={{ color: 'var(--s-muted)' }}>Total</span>
          <span className="text-sm font-mono font-semibold heading">{logs.length}</span>
        </div>
      </div>
    </div>
  );
}

function RecentLogs({ logs, loading }: { logs: LogEntry[]; loading: boolean }) {
  const recent = logs.slice(0, 8);
  return (
    <div className="glass-card overflow-hidden">
      <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--s-border)' }}>
        <h3 className="text-sm font-semibold heading">Recent Activity</h3>
        <a href="/logs" className="text-xs text-brand-magenta hover:text-brand-pink transition-colors">View all →</a>
      </div>
      <div>
        {recent.map((log, i) => (
          <div key={i} className="px-5 py-3 flex items-center gap-4 transition-colors" style={{ borderTop: i > 0 ? '1px solid var(--s-border)' : undefined }}>
            <div className={`w-2 h-2 rounded-full shrink-0 ${
              log.result === 'success' ? 'bg-emerald-400' : log.result === 'failure' ? 'bg-red-400' : 'bg-amber-400'
            }`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium truncate" style={{ color: 'var(--s-text)' }}>{log.user || '-'}</span>
                <span className="text-xs" style={{ color: 'var(--s-muted)' }}>→</span>
                <span className="text-sm truncate" style={{ color: 'var(--s-muted)' }}>{log.device || log.deviceIp || '-'}</span>
              </div>
              <p className="text-xs truncate mt-0.5" style={{ color: 'var(--s-muted)', opacity: 0.7 }}>{log.detail}</p>
            </div>
            <div className="text-right shrink-0">
              <span className={`badge ${
                log.type === 'authentication' ? 'badge-admin' :
                log.type === 'authorization' ? 'badge-readonly' : 'badge-success'
              }`}>{log.type}</span>
              <p className="text-[10px] mt-1" style={{ color: 'var(--s-muted)' }}>{log.timestamp.split(/[T ]/)[1]?.slice(0, 8) ?? ''}</p>
            </div>
          </div>
        ))}
        {recent.length === 0 && (
          <div className="px-5 py-10 text-center text-sm" style={{ color: 'var(--s-muted)' }}>
            {loading ? 'Loading…' : 'No AAA events today - activity appears once devices start authenticating.'}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();

  const users = useApi(api.getUsers);
  const devices = useApi(api.getDevices);
  const logs = useApi(() => api.getLogs());
  const files = useApi(api.getConfigFiles);
  const status = useApi(api.getStatus);
  const settings = useApi(api.getServerSettings);
  const ldap = useApi(api.ldapHealth);
  // Re-probe the directory every 60s so the indicator stays live.
  useEffect(() => {
    const id = setInterval(() => void ldap.reload(), 60_000);
    return () => clearInterval(id);
  }, [ldap.reload]);
  const ldapState: 'loading' | 'error' | 'disabled' | 'connected' | 'disconnected' =
    ldap.data
      ? !ldap.data.enabled
        ? 'disabled'
        : ldap.data.connected
          ? 'connected'
          : 'disconnected'
      : ldap.error
        ? 'error'
        : 'loading';
  const ldapColor =
    ldapState === 'connected'
      ? 'var(--s-chart-success)'
      : ldapState === 'disconnected'
        ? 'var(--s-chart-failure)'
        : 'var(--s-muted)';
  const ldapBadge =
    ldapState === 'connected' ? 'badge-success' : ldapState === 'disconnected' ? 'badge-danger' : 'badge-warning';
  const ldapLabel =
    ldapState === 'connected'
      ? 'Connected'
      : ldapState === 'disconnected'
        ? 'Disconnected'
        : ldapState === 'disabled'
          ? 'Disabled'
          : ldapState === 'error'
            ? 'Unavailable'
            : '-';
  const ldapTitle = ldap.data?.message ?? ldap.error ?? '';
  const tacacs = status.data?.tacacs ?? null;
  const tacacsHealthy = tacacs?.online === true && (!tacacs.health || tacacs.health === 'healthy');

  const userList = users.data ?? [];
  const deviceList = devices.data ?? [];
  const logList = logs.data ?? [];

  const authLogs = logList.filter(l => l.type === 'authentication');
  const failedToday = authLogs.filter(l => l.result === 'failure').length;
  const successRate = authLogs.length > 0
    ? Math.round((authLogs.filter(l => l.result === 'success').length / authLogs.length) * 1000) / 10
    : null;

  const lastConfigChange = (files.data ?? [])
    .map(f => f.modified)
    .sort()
    .at(-1);

  const agentDown = users.error !== null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold heading">Dashboard</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--s-muted)' }}>Soteria TACACS+ server overview</p>
      </div>

      {agentDown && (
        <div className="glass-card p-4 border-l-2 border-red-500">
          <p className="text-sm text-red-400">{users.error}</p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Users} label="Local Users" value={userList.length} sub={`${userList.filter(u => u.status === 'active').length} active`} color="bg-brand-purple/15 text-brand-magenta" onClick={() => navigate('/users')} />
        <StatCard icon={Server} label="Devices" value={deviceList.length} sub="registered (NAS)" color="bg-blue-500/15 text-blue-400" onClick={() => navigate('/devices')} />
        <StatCard icon={ShieldCheck} label="Auth Success Rate" value={successRate !== null ? `${successRate}%` : '-'} sub={`${authLogs.length} attempts today`} color="bg-emerald-500/15 text-emerald-400" onClick={() => navigate('/logs')} />
        <StatCard icon={AlertTriangle} label="Failed Attempts" value={failedToday} sub="Today" color="bg-red-500/15 text-red-400" onClick={() => navigate('/logs')} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <RecentLogs logs={logList} loading={logs.loading} />
        </div>

        <div className="space-y-4">
          <AaaCountsCard logs={logList} onOpenLogs={() => navigate('/logs')} />
          <div className="glass-card p-5 space-y-4">
            <h3 className="text-sm font-semibold heading">System Status</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Activity className={`w-4 h-4 ${agentDown ? 'text-red-400' : 'text-emerald-400'}`} />
                  <span className="text-sm" style={{ color: 'var(--s-text)' }}>Agent</span>
                  {status.data?.agent.uptime && (
                    <span className="text-xs font-mono" style={{ color: 'var(--s-muted)' }}>{status.data.agent.uptime}</span>
                  )}
                </div>
                <span className={agentDown ? 'badge-danger' : 'badge-success'}>{agentDown ? 'Unreachable' : 'Connected'}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Server className={`w-4 h-4 ${tacacsHealthy ? 'text-emerald-400' : tacacs?.online ? 'text-amber-400' : 'text-red-400'}`} />
                  <span className="text-sm" style={{ color: 'var(--s-text)' }}>TACACS+ Server</span>
                  {tacacs?.uptime && (
                    <span className="text-xs font-mono" style={{ color: 'var(--s-muted)' }}>{tacacs.uptime}</span>
                  )}
                </div>
                <span className={tacacsHealthy ? 'badge-success' : tacacs?.online ? 'badge-warning' : 'badge-danger'}>
                  {tacacsHealthy ? 'Healthy' : tacacs?.online ? tacacs.health : status.data ? 'Offline' : '-'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Wifi className="w-4 h-4" style={{ color: ldapColor }} />
                  <span className="text-sm" style={{ color: 'var(--s-text)' }}>LDAP Backend</span>
                </div>
                <span className={ldapBadge} title={ldapTitle}>{ldapLabel}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Lock className="w-4 h-4" style={{ color: 'var(--s-muted)' }} />
                  <span className="text-sm" style={{ color: 'var(--s-text)' }}>TLS</span>
                </div>
                <span className={settings.data?.tlsEnabled ? 'badge-success' : 'badge-warning'}>
                  {settings.data ? (settings.data.tlsEnabled ? 'Enabled' : 'Disabled') : '-'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4" style={{ color: 'var(--s-muted)' }} />
                  <span className="text-sm" style={{ color: 'var(--s-text)' }}>Last Config Change</span>
                </div>
                <span className="text-xs font-mono" style={{ color: 'var(--s-muted)' }}>
                  {lastConfigChange ? lastConfigChange.replace('T', ' ').replace('Z', '') : '-'}
                </span>
              </div>
            </div>
          </div>

          <AuthActivityChart logs={logList} loading={logs.loading} />
          <AuthActivityChart
            logs={logList}
            loading={logs.loading}
            type="authorization"
            title="Authorization Activity Today"
            successLabel="Permit"
            failureLabel="Deny"
          />
        </div>
      </div>
    </div>
  );
}
