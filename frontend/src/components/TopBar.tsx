import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Menu, Activity, Sun, Moon, Play, LogOut, ShieldCheck, KeyRound, Zap, UserPlus, ServerCog, ArrowUpCircle, ArrowDownCircle, AlertTriangle } from 'lucide-react';
import { api, type SystemStatus } from '../lib/api';
import { loadNotifications, saveNotifications, makeNotification, type SysNotification } from '../lib/notifications';
import { useTheme } from './ThemeProvider';
import { useConfigMode } from './ConfigModeProvider';
import { useAuth } from './AuthProvider';
import ChangePasswordModal from './ChangePasswordModal';
import TwoFactorModal from './TwoFactorModal';

interface TopBarProps {
  onMenuToggle: () => void;
}

function initialsFrom(email: string | undefined, fullName: string | undefined): string {
  if (fullName) {
    const parts = fullName.trim().split(/\s+/);
    return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
  }
  return (email ?? '?').slice(0, 2).toUpperCase();
}

export default function TopBar({ onMenuToggle }: TopBarProps) {
  const { theme, toggle } = useTheme();
  const { editMode, enterEdit } = useConfigMode();
  const { user, isAdmin, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [twoFactorOpen, setTwoFactorOpen] = useState(false);
  const navigate = useNavigate();

  const quickActions = [
    { label: 'Add User', icon: UserPlus, run: () => navigate('/users') },
    { label: 'Add Device', icon: ServerCog, run: () => navigate('/devices') },
    ...(!editMode ? [{ label: 'Enter Config Mode', icon: Play, run: () => { void enterEdit(); navigate('/config'); } }] : []),
  ];
  const [status, setStatus] = useState<SystemStatus | null | 'offline'>(null);
  const [notifications, setNotifications] = useState<SysNotification[]>(loadNotifications);
  const unread = notifications.filter(n => !n.read).length;
  // Last observed service states, for transition detection across polls.
  const prevState = useRef<{ agent?: string; tacacs?: string }>({});

  const pushNotifications = (items: SysNotification[]) => {
    if (items.length === 0) return;
    setNotifications(prev => {
      const next = [...items, ...prev].slice(0, 50);
      saveNotifications(next);
      return next;
    });
  };

  // Poll agent + TACACS status; record up/down transitions as notifications.
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      let agentState: string;
      let tacacsState: string | undefined;
      try {
        const st = await api.getStatus();
        if (cancelled) return;
        setStatus(st);
        agentState = st.agent.online ? 'online' : 'offline';
        tacacsState = !st.tacacs.online ? 'offline'
          : (!st.tacacs.health || st.tacacs.health === 'healthy') ? 'healthy' : 'unhealthy';
      } catch {
        if (cancelled) return;
        setStatus('offline');
        agentState = 'offline';
        tacacsState = undefined; // agent unreachable - can't tell TACACS state
      }

      const prev = prevState.current;
      const newNotifs: SysNotification[] = [];
      if (prev.agent !== undefined && prev.agent !== agentState) {
        newNotifs.push(agentState === 'online'
          ? makeNotification('up', 'Agent is back online')
          : makeNotification('down', 'Agent went offline'));
      }
      if (tacacsState !== undefined && prev.tacacs !== undefined && prev.tacacs !== tacacsState) {
        if (tacacsState === 'healthy') newNotifs.push(makeNotification('up', 'TACACS+ server recovered'));
        else if (tacacsState === 'offline') newNotifs.push(makeNotification('down', 'TACACS+ server went down'));
        else newNotifs.push(makeNotification('warn', 'TACACS+ server is unhealthy'));
      }
      pushNotifications(newNotifs);

      prevState.current = { agent: agentState, tacacs: tacacsState ?? prev.tacacs };
    };
    void check();
    const timer = setInterval(check, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const markAllRead = () => setNotifications(prev => {
    const next = prev.map(n => ({ ...n, read: true }));
    saveNotifications(next);
    return next;
  });

  const clearNotifications = () => {
    setNotifications([]);
    saveNotifications([]);
  };

  const openNotifications = () => {
    const opening = !notifOpen;
    setNotifOpen(opening);
    if (opening) markAllRead();
  };

  const sys = status !== null && status !== 'offline' ? status : null;
  const agentOnline = sys?.agent.online === true;
  const tacacs = sys?.tacacs ?? null;
  const tacacsHealthy = tacacs?.online === true && (tacacs.health === 'healthy' || tacacs.health === '' || tacacs.health === undefined);

  const fullName = (user?.user_metadata as { full_name?: string } | undefined)?.full_name;

  return (
    <header className="h-16 flex items-center justify-between px-4 lg:px-6 shrink-0" style={{ backgroundColor: 'var(--s-surface)', borderBottom: '1px solid var(--s-border)' }}>
      {/* Left */}
      <div className="flex items-center gap-3 min-w-0">
        <button onClick={onMenuToggle} className="lg:hidden transition-colors" style={{ color: 'var(--s-muted)' }} aria-label="Open menu">
          <Menu className="w-5 h-5" />
        </button>
        {/* Compact brand on mobile (the sidebar logo is off-canvas there) */}
        <div className="flex items-center gap-2 lg:hidden min-w-0">
          <img src="/assets/media-logo.png" alt="Soteria" className="w-7 h-7 rounded-md shrink-0 object-contain" />
          <span className="text-sm font-bold tracking-wide truncate heading">SOTERIA</span>
        </div>
      </div>

      {/* Right */}
      <div className="flex items-center gap-2 lg:gap-3">
        {/* Quick actions */}
        <div className="relative">
          <button onClick={() => setQuickOpen(!quickOpen)} className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors" style={{ backgroundColor: 'var(--s-bg)', border: '1px solid var(--s-border)', color: 'var(--s-text)' }}>
            <Zap className="w-3.5 h-3.5 text-brand-magenta" /> Quick Actions
          </button>
          {quickOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setQuickOpen(false)} />
              <div className="absolute right-0 top-10 z-50 w-52 rounded-xl shadow-2xl py-1" style={{ backgroundColor: 'var(--s-surface)', border: '1px solid var(--s-border)' }}>
                {quickActions.map(a => (
                  <button
                    key={a.label}
                    onClick={() => { setQuickOpen(false); a.run(); }}
                    className="w-full px-3 py-2 text-left text-sm flex items-center gap-2.5"
                    style={{ color: 'var(--s-text)' }}
                    onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--s-hover)')}
                    onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    <a.icon className="w-4 h-4" style={{ color: 'var(--s-muted)' }} /> {a.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Config edit mode toggle */}
        {!editMode && (
          <button onClick={enterEdit} className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors" style={{ backgroundColor: 'var(--s-bg)', border: '1px solid var(--s-border)', color: 'var(--s-text)' }}>
            <Play className="w-3.5 h-3.5" /> Edit Config
          </button>
        )}

        {/* Agent Status */}
        <div
          className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg"
          style={{ backgroundColor: 'var(--s-bg)', border: '1px solid var(--s-border)' }}
          title={sys?.agent.startedAt ? `Agent up since ${sys.agent.startedAt}` : undefined}
        >
          <Activity className={`w-3.5 h-3.5 ${status === null ? '' : agentOnline ? 'text-emerald-400' : 'text-red-400'}`} style={status === null ? { color: 'var(--s-muted)' } : undefined} />
          <span className="text-xs font-medium" style={{ color: 'var(--s-text)' }}>
            {status === null ? 'Agent…' : agentOnline ? 'Agent Online' : 'Agent Offline'}
          </span>
          {agentOnline && sys?.agent.uptime && (
            <span className="text-xs font-mono" style={{ color: 'var(--s-muted)' }}>{sys.agent.uptime}</span>
          )}
        </div>

        {/* TACACS Server Status */}
        <div
          className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg"
          style={{ backgroundColor: 'var(--s-bg)', border: '1px solid var(--s-border)' }}
          title={tacacs?.health ? `Container health: ${tacacs.health}` : undefined}
        >
          <div className={`w-2 h-2 rounded-full ${
            status === null ? 'bg-gray-400' :
            tacacsHealthy ? 'bg-emerald-400' :
            tacacs?.online ? 'bg-amber-400' : 'bg-red-400'
          }`} />
          <span className="text-xs font-medium" style={{ color: 'var(--s-text)' }}>
            {status === null ? 'TACACS…' : tacacsHealthy ? 'TACACS Online' : tacacs?.online ? `TACACS ${tacacs.health}` : 'TACACS Offline'}
          </span>
          {tacacs?.online && tacacs.uptime && (
            <span className="text-xs font-mono" style={{ color: 'var(--s-muted)' }}>{tacacs.uptime}</span>
          )}
        </div>

        {/* Theme toggle */}
        <button
          onClick={toggle}
          className="p-2 rounded-lg transition-all duration-200 hover:scale-105"
          style={{ color: 'var(--s-muted)' }}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <Sun className="w-[18px] h-[18px]" /> : <Moon className="w-[18px] h-[18px]" />}
        </button>

        {/* Notifications - system up/down events */}
        <div className="relative">
          <button onClick={openNotifications} className="relative p-2 transition-colors" style={{ color: 'var(--s-muted)' }}>
            <Bell className="w-5 h-5" />
            {unread > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 bg-red-500 rounded-full flex items-center justify-center">
                <span className="text-[10px] font-bold text-white">{unread > 99 ? '99+' : unread}</span>
              </span>
            )}
          </button>
          {notifOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setNotifOpen(false)} />
              <div className="absolute right-0 top-10 z-50 w-80 rounded-xl shadow-2xl overflow-hidden" style={{ backgroundColor: 'var(--s-surface)', border: '1px solid var(--s-border)' }}>
                <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid var(--s-border)' }}>
                  <span className="text-sm font-semibold heading">System Notifications</span>
                  {notifications.length > 0 && (
                    <button onClick={clearNotifications} className="text-xs text-brand-magenta hover:text-brand-pink transition-colors">Clear all</button>
                  )}
                </div>
                {notifications.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm" style={{ color: 'var(--s-muted)' }}>
                    No system events. Agent and TACACS+ up/down changes appear here.
                  </div>
                ) : (
                  <div className="max-h-80 overflow-y-auto">
                    {notifications.map((n, i) => {
                      const Icon = n.kind === 'up' ? ArrowUpCircle : n.kind === 'down' ? ArrowDownCircle : AlertTriangle;
                      const color = n.kind === 'up' ? 'text-emerald-400' : n.kind === 'down' ? 'text-red-400' : 'text-amber-400';
                      return (
                        <div key={n.id} className="px-4 py-2.5 flex items-start gap-2.5" style={{ borderTop: i > 0 ? '1px solid var(--s-border)' : undefined }}>
                          <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${color}`} />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm truncate" style={{ color: 'var(--s-text)' }}>{n.text}</p>
                            <p className="text-[10px] font-mono" style={{ color: 'var(--s-muted)' }}>{new Date(n.ts).toLocaleString()}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* User menu */}
        <div className="relative">
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-purple to-brand-magenta flex items-center justify-center transition-transform hover:scale-105"
            title={user?.email}
          >
            <span className="text-xs font-bold text-white">{initialsFrom(user?.email, fullName)}</span>
          </button>

          {menuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
              <div
                className="absolute right-0 top-10 z-50 w-64 rounded-xl shadow-2xl overflow-hidden"
                style={{ backgroundColor: 'var(--s-surface)', border: '1px solid var(--s-border)' }}
              >
                <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--s-border)' }}>
                  <p className="text-sm font-semibold truncate heading">{fullName ?? user?.email}</p>
                  <p className="text-xs truncate" style={{ color: 'var(--s-muted)' }}>{user?.email}</p>
                  {isAdmin && (
                    <span className="badge-admin mt-2">
                      <ShieldCheck className="w-3 h-3 mr-1" /> Administrator
                    </span>
                  )}
                </div>
                <button
                  onClick={() => { setMenuOpen(false); setChangePasswordOpen(true); }}
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-sm transition-colors"
                  style={{ color: 'var(--s-text)' }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--s-hover)')}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '')}
                >
                  <KeyRound className="w-4 h-4" /> Change password
                </button>
                <button
                  onClick={() => { setMenuOpen(false); setTwoFactorOpen(true); }}
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-sm transition-colors"
                  style={{ color: 'var(--s-text)' }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--s-hover)')}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '')}
                >
                  <ShieldCheck className="w-4 h-4" /> Two-factor auth
                </button>
                <button
                  onClick={() => { setMenuOpen(false); signOut(); }}
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-red-400 transition-colors hover:bg-red-500/10"
                >
                  <LogOut className="w-4 h-4" /> Sign out
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <ChangePasswordModal open={changePasswordOpen} onClose={() => setChangePasswordOpen(false)} />
      <TwoFactorModal open={twoFactorOpen} onClose={() => setTwoFactorOpen(false)} />
    </header>
  );
}
