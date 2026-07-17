import { Wrench } from 'lucide-react';
import { Link } from 'react-router-dom';
import WebUsersSection from '../components/WebUsersSection';
import RolesSection from '../components/RolesSection';
import ApiTokensSection from '../components/ApiTokensSection';
import AuthMethodsSection from '../components/AuthMethodsSection';
import ConnectMobileSection from '../components/ConnectMobileSection';

// Web UI settings only. TACACS server configuration lives under
// System Management > TACACS Settings.
export default function Settings() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold heading">Settings</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--s-muted)' }}>Web UI administration: accounts, access, and authentication for this dashboard</p>
      </div>

      {/* Left: access management. Right: authentication. */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
        <div className="space-y-6">
          <RolesSection />
          <WebUsersSection />
          <ApiTokensSection />
        </div>
        <div className="space-y-6">
          <AuthMethodsSection />
          <ConnectMobileSection />
        </div>
      </div>

      <div className="glass-card p-4 flex items-center gap-3">
        <Wrench className="w-4 h-4 shrink-0" style={{ color: 'var(--s-muted)' }} />
        <p className="text-sm" style={{ color: 'var(--s-muted)' }}>
          Looking for TACACS+ server options (AAA log export, environment settings)? They moved to{' '}
          <Link to="/tacacs-settings" className="text-brand-magenta hover:text-brand-pink transition-colors">System Management → TACACS+ Settings</Link>.
        </p>
      </div>
    </div>
  );
}
