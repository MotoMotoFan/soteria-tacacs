import { useState } from 'react';
import { KeyRound, Terminal, Activity, CheckCircle, XCircle, AlertCircle, Play, Route } from 'lucide-react';
import { api, ApiError, type ToolResult, type PingResult, type TraceResult } from '../lib/api';

// Tools: live diagnostics that run from the TACACS server's perspective
// (auth/authz hit the real daemon; ping runs inside the server container).
// Room to grow - MTR, traceroute, etc. slot in as more ToolCard sections.
export default function Tools() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold heading">Tools</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--s-muted)' }}>
          Live diagnostics run from the TACACS+ server's perspective - auth/authorization tests hit the real daemon and appear in the AAA logs.
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <AuthTester />
        <AuthzTester />
        <TraceTester />
        <PingTester />
      </div>
    </div>
  );
}

function VerdictBadge({ verdict }: { verdict: string }) {
  const good = verdict === 'OK' || verdict === 'PERMIT';
  const bad = verdict === 'FAIL' || verdict === 'DENY';
  const Icon = good ? CheckCircle : bad ? XCircle : AlertCircle;
  const cls = good ? 'badge-success' : bad ? 'badge-danger' : 'badge-warning';
  return (
    <span className={`${cls} inline-flex items-center gap-1.5`}>
      <Icon className="w-3.5 h-3.5" /> {verdict}
    </span>
  );
}

function ToolCard({ icon: Icon, title, description, children }: {
  icon: React.ElementType; title: string; description: string; children: React.ReactNode;
}) {
  return (
    <div className="glass-card p-6">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-9 h-9 rounded-lg bg-brand-purple/15 flex items-center justify-center">
          <Icon className="w-[18px] h-[18px] text-brand-magenta" />
        </div>
        <div>
          <h3 className="text-base font-semibold heading">{title}</h3>
          <p className="text-xs" style={{ color: 'var(--s-muted)' }}>{description}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function useTool<T>() {
  const [result, setResult] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const run = async (fn: () => Promise<T>) => {
    setError(null);
    setResult(null);
    setRunning(true);
    try {
      setResult(await fn());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };
  return { result, error, running, run };
}

function AuthTester() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const { result, error, running, run } = useTool<ToolResult>();

  return (
    <ToolCard icon={KeyRound} title="Authentication Test" description="PAP login against the live server (localhost:49)">
      <form className="space-y-4" onSubmit={e => { e.preventDefault(); void run(() => api.authTest(username.trim(), password)); }}>
        <div>
          <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Username</label>
          <input className="input-field font-mono" placeholder="e.g. network_readonly" value={username} onChange={e => setUsername(e.target.value)} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Password</label>
          <input type="password" className="input-field font-mono" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} />
        </div>
        <button type="submit" disabled={running || !username.trim() || !password} className="btn-primary flex items-center gap-2 text-sm">
          <Play className="w-4 h-4" /> {running ? 'Testing…' : 'Test Login'}
        </button>
      </form>
      <ResultPanel error={error} result={result} />
    </ToolCard>
  );
}

function AuthzTester() {
  const [username, setUsername] = useState('');
  const [service, setService] = useState('shell');
  const [command, setCommand] = useState('');
  const { result, error, running, run } = useTool<ToolResult>();

  return (
    <ToolCard icon={Terminal} title="Command Authorization Test" description="Would the server permit this command for this user?">
      <form className="space-y-4" onSubmit={e => { e.preventDefault(); void run(() => api.authzTest(username.trim(), service.trim(), command.trim())); }}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Username</label>
            <input className="input-field font-mono" placeholder="e.g. network_admin" value={username} onChange={e => setUsername(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Service</label>
            <input className="input-field font-mono" value={service} onChange={e => setService(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Command</label>
          <input className="input-field font-mono" placeholder="e.g. show running-config (empty = session/priv-lvl check)" value={command} onChange={e => setCommand(e.target.value)} />
        </div>
        <button type="submit" disabled={running || !username.trim()} className="btn-primary flex items-center gap-2 text-sm">
          <Play className="w-4 h-4" /> {running ? 'Testing…' : 'Test Authorization'}
        </button>
      </form>
      <ResultPanel error={error} result={result} />
    </ToolCard>
  );
}

function TraceTester() {
  const [mode, setMode] = useState('authz');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [service, setService] = useState('shell');
  const [command, setCommand] = useState('');
  const [group, setGroup] = useState('');
  const { result, error, running, run } = useTool<TraceResult>();

  return (
    <ToolCard icon={Route} title="AAA Trace" description="Trace an auth decision through the live rules (tactrace.pl)">
      <form className="space-y-4" onSubmit={e => { e.preventDefault(); void run(() => api.traceTest(mode, username.trim(), password, service.trim(), command.trim(), group.trim())); }}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Mode</label>
            <select className="select-field" value={mode} onChange={e => setMode(e.target.value)}>
              <option value="authz">Authorization</option>
              <option value="authc">Authentication</option>
              <option value="acct">Accounting</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Username</label>
            <input className="input-field font-mono" placeholder="e.g. alice" value={username} onChange={e => setUsername(e.target.value)} />
          </div>
        </div>
        {mode !== 'authc' && (
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Group (optional)</label>
            <input className="input-field font-mono" placeholder="e.g. tacacs_admin (trace a directory user as this group)" value={group} onChange={e => setGroup(e.target.value)} />
          </div>
        )}
        {mode === 'authc' ? (
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Password</label>
            <input type="password" className="input-field font-mono" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} />
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Service</label>
              <input className="input-field font-mono" value={service} onChange={e => setService(e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Command</label>
              <input className="input-field font-mono" placeholder="empty = session/priv-lvl check" value={command} onChange={e => setCommand(e.target.value)} />
            </div>
          </div>
        )}
        <button type="submit" disabled={running || !username.trim() || (mode === 'authc' && !password)} className="btn-primary flex items-center gap-2 text-sm">
          <Play className="w-4 h-4" /> {running ? 'Tracing…' : 'Run Trace'}
        </button>
      </form>
      {error && <div className="mt-4 rounded-lg p-3 text-sm text-red-400" style={{ backgroundColor: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>{error}</div>}
      {result && (
        <div className="mt-4 space-y-2">
          <div className="flex items-center gap-2">
            <VerdictBadge verdict={result.verdict} />
            <span className="text-xs" style={{ color: 'var(--s-muted)' }}>{result.latencyMs} ms</span>
          </div>
          <pre className="config-preview whitespace-pre-wrap text-xs overflow-x-auto">{result.output}</pre>
          <p className="text-xs" style={{ color: 'var(--s-muted)' }}>Traces your live ruleset, profiles, groups and local users. For a directory (LDAP) user, set Group to trace the rules as if they were a member of it (the LDAP backend can't run inside the trace).</p>
        </div>
      )}
    </ToolCard>
  );
}

function PingTester() {
  const [target, setTarget] = useState('');
  const [count, setCount] = useState('4');
  const { result, error, running, run } = useTool<PingResult>();

  return (
    <ToolCard icon={Activity} title="Ping" description="fping from the TACACS+ server container (reachability to a NAS)">
      <form className="space-y-4" onSubmit={e => { e.preventDefault(); void run(() => api.pingTest(target.trim(), parseInt(count, 10) || 4)); }}>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Target</label>
            <input className="input-field font-mono" placeholder="IP or hostname" value={target} onChange={e => setTarget(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Count</label>
            <input type="number" min={1} max={10} className="input-field font-mono" value={count} onChange={e => setCount(e.target.value)} />
          </div>
        </div>
        <button type="submit" disabled={running || !target.trim()} className="btn-primary flex items-center gap-2 text-sm">
          <Play className="w-4 h-4" /> {running ? 'Pinging…' : 'Run Ping'}
        </button>
      </form>
      {error && <div className="mt-4 rounded-lg p-3 text-sm text-red-400" style={{ backgroundColor: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>{error}</div>}
      {result && (
        <div className="mt-4 space-y-2">
          <div className="flex items-center gap-2">
            <VerdictBadge verdict={result.success ? 'OK' : 'FAIL'} />
            <span className="text-xs" style={{ color: 'var(--s-muted)' }}>{result.latencyMs} ms</span>
          </div>
          <pre className="config-preview whitespace-pre-wrap text-xs">{result.output}</pre>
        </div>
      )}
    </ToolCard>
  );
}

function ResultPanel({ error, result }: { error: string | null; result: ToolResult | null }) {
  if (error) {
    return <div className="mt-4 rounded-lg p-3 text-sm text-red-400" style={{ backgroundColor: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>{error}</div>;
  }
  if (!result) return null;
  return (
    <div className="mt-4 space-y-2">
      <div className="flex items-center gap-2">
        <VerdictBadge verdict={result.verdict} />
        <span className="text-xs" style={{ color: 'var(--s-muted)' }}>{result.latencyMs} ms</span>
      </div>
      {result.message && <p className="text-sm" style={{ color: 'var(--s-text)' }}>{result.message}</p>}
      {result.attributes && result.attributes.length > 0 && (
        <div>
          <p className="text-xs font-medium mb-1" style={{ color: 'var(--s-muted)' }}>Returned attributes:</p>
          <pre className="config-preview text-xs">{result.attributes.join('\n')}</pre>
        </div>
      )}
    </div>
  );
}
