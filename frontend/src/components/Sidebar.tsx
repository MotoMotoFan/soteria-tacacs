import { useState } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Users, Server, ShieldCheck,
  GitBranch, ScrollText, FileCode, Settings, ChevronLeft, ChevronDown, Play,
  Boxes, UsersRound, Wrench, History, SlidersHorizontal, Wand2 as Wrench2, X, Globe, Network,
} from 'lucide-react';
import { useConfigMode } from './ConfigModeProvider';

interface SidebarProps {
  /** Desktop: labels shown (expanded) vs icon-only rail. */
  open: boolean;
  /** Desktop collapse toggle (the chevron at the bottom). */
  onToggle: () => void;
  /** Mobile: the off-canvas drawer is visible. */
  mobileOpen: boolean;
  /** Close the mobile drawer (backdrop tap or nav). */
  onMobileClose: () => void;
}

interface NavLeaf {
  to: string;
  icon: React.ElementType;
  label: string;
}

interface NavSection {
  icon: React.ElementType;
  label: string;
  children: NavLeaf[];
}

type NavEntry = NavLeaf | NavSection;

const navItems: NavEntry[] = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  {
    icon: Server, label: 'Device Management', children: [
      { to: '/devices', icon: Server, label: 'Devices' },
      { to: '/device-groups', icon: Boxes, label: 'Device Groups' },
    ],
  },
  {
    icon: Users, label: 'User Management', children: [
      { to: '/users', icon: Users, label: 'Users' },
      { to: '/groups', icon: UsersRound, label: 'User Groups' },
    ],
  },
  {
    icon: ShieldCheck, label: 'Access Control', children: [
      { to: '/profiles', icon: ShieldCheck, label: 'Profiles' },
      { to: '/rulesets', icon: GitBranch, label: 'Rulesets' },
    ],
  },
  {
    icon: Wrench, label: 'System Management', children: [
      { to: '/logs', icon: ScrollText, label: 'AAA Logs' },
      { to: '/config', icon: FileCode, label: 'Configuration' },
      { to: '/backups', icon: History, label: 'Backups' },
      { to: '/tacacs-settings', icon: SlidersHorizontal, label: 'TACACS+ Settings' },
    ],
  },
  {
    icon: Globe, label: 'DNS Management', children: [
      { to: '/dns/domains', icon: Globe, label: 'Authoritative Domains' },
      { to: '/dns/reverse', icon: Network, label: 'Reverse Zones' },
    ],
  },
  { to: '/tools', icon: Wrench2, label: 'Tools' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

const isSection = (e: NavEntry): e is NavSection => 'children' in e;

const SURFACE = { backgroundColor: 'var(--s-surface)', borderRight: '1px solid var(--s-border)' };

export default function Sidebar({ open, onToggle, mobileOpen, onMobileClose }: SidebarProps) {
  const location = useLocation();
  const { editMode, enterEdit } = useConfigMode();
  const isDashboard = location.pathname === '/';

  const sectionOfPath = (path: string) =>
    navItems.filter(isSection).find(s => s.children.some(c => path.startsWith(c.to)))?.label ?? null;

  // Sections start expanded when they contain the current route.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    const active = sectionOfPath(location.pathname);
    return Object.fromEntries(navItems.filter(isSection).map(s => [s.label, s.label !== active]));
  });

  const leafActive = (to: string) =>
    to === '/' ? location.pathname === '/' : location.pathname.startsWith(to);

  // `expanded` = labels shown (always true in the mobile drawer; toggles on desktop).
  const renderLeaf = (expanded: boolean, { to, icon: Icon, label }: NavLeaf, indent = false) => (
    <NavLink
      key={to}
      to={to}
      onClick={onMobileClose}
      className={leafActive(to) ? 'sidebar-link-active' : 'sidebar-link-inactive'}
      style={indent && expanded ? { paddingLeft: '2.25rem' } : undefined}
      title={!expanded ? label : undefined}
    >
      <Icon className={`shrink-0 ${indent ? 'w-4 h-4' : 'w-[18px] h-[18px]'}`} />
      {expanded && <span className="truncate">{label}</span>}
    </NavLink>
  );

  // Shared sidebar body, reused by the desktop rail and the mobile drawer.
  const body = (expanded: boolean, isMobileDrawer: boolean) => (
    <>
      {/* Logo */}
      <div className="h-16 flex items-center justify-between px-4" style={{ borderBottom: '1px solid var(--s-border)' }}>
        <div className="flex items-center gap-3 min-w-0">
          <img src="/assets/media-logo.png" alt="Soteria" className="w-9 h-9 rounded-lg shrink-0 object-contain" />
          {expanded && (
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-bold tracking-wide truncate heading">SOTERIA</span>
              <span className="text-[10px] font-medium tracking-widest uppercase" style={{ color: 'var(--s-muted)' }}>TACACS+</span>
            </div>
          )}
        </div>
        {isMobileDrawer && (
          <button onClick={onMobileClose} className="p-1 shrink-0" style={{ color: 'var(--s-muted)' }} aria-label="Close menu">
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
        {navItems.map(entry => {
          if (!isSection(entry)) return renderLeaf(expanded, entry);

          const { icon: Icon, label, children } = entry;
          const sectionActive = children.some(c => leafActive(c.to));
          const isCollapsed = collapsed[label] && !(!expanded && sectionActive);

          // Icon-only rail: no room for section headers - render children directly.
          if (!expanded) return children.map(c => renderLeaf(expanded, c));

          return (
            <div key={label}>
              <button
                onClick={() => setCollapsed(prev => ({ ...prev, [label]: !prev[label] }))}
                className={sectionActive ? 'sidebar-link-active w-full' : 'sidebar-link-inactive w-full'}
              >
                <Icon className="w-[18px] h-[18px] shrink-0" />
                <span className="truncate flex-1 text-left">{label}</span>
                <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform duration-200 ${isCollapsed ? '-rotate-90' : ''}`} />
              </button>
              {!isCollapsed && (
                <div className="mt-1 space-y-1">
                  {children.map(c => renderLeaf(expanded, c, true))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Config mode button - visible on all pages except dashboard */}
      {!isDashboard && !editMode && expanded && (
        <div className="px-3 pb-3">
          <button
            onClick={() => { void enterEdit(); if (isMobileDrawer) onMobileClose(); }}
            className="btn-secondary w-full text-xs flex items-center justify-center gap-2 py-2"
          >
            <Play className="w-3.5 h-3.5" /> Edit Config
          </button>
        </div>
      )}

      {/* Collapse toggle (desktop rail only) */}
      {!isMobileDrawer && (
        <button
          onClick={onToggle}
          className="h-12 flex items-center justify-center transition-colors"
          style={{ borderTop: '1px solid var(--s-border)', color: 'var(--s-muted)' }}
        >
          <ChevronLeft className={`w-4 h-4 transition-transform duration-300 ${!expanded ? 'rotate-180' : ''}`} />
        </button>
      )}
    </>
  );

  return (
    <>
      {/* Desktop rail: in-flow, collapsible. Hidden on mobile. */}
      <aside
        className={`hidden lg:flex flex-col shrink-0 transition-all duration-300 ease-in-out ${open ? 'w-64' : 'w-[72px]'}`}
        style={SURFACE}
      >
        {body(open, false)}
      </aside>

      {/* Mobile drawer + backdrop, portaled to <body> so no ancestor overflow or
          stacking context can clip or hide it. Hidden on desktop. */}
      {createPortal(
        <div className="lg:hidden">
          <div
            className={`fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm transition-opacity duration-300 ${mobileOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
            onClick={onMobileClose}
          />
          <aside
            className={`fixed inset-y-0 left-0 z-[70] w-64 flex flex-col transition-transform duration-300 ease-in-out ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
            style={SURFACE}
          >
            {body(true, true)}
          </aside>
        </div>,
        document.body,
      )}
    </>
  );
}
