import { useState, useEffect, useRef, FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Mail, Lock, Eye, EyeOff, LogIn, AlertCircle, Sun, Moon, Loader2, ShieldCheck, ArrowLeft, KeyRound } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../components/AuthProvider';
import { useTheme } from '../components/ThemeProvider';
import { listAuthSettings, ldapSignIn } from '../lib/authsettings';

interface EnrollData {
  factorId: string;
  qrCode: string;
  secret: string;
}

function qrSrc(qr: string): string {
  if (qr.startsWith('data:')) return qr;
  return 'data:image/svg+xml;utf-8,' + encodeURIComponent(qr);
}

export default function Login() {
  const { session, loading, mfaPending, mfaEnrollRequired, refreshMfa, signIn, signOut } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [enrollData, setEnrollData] = useState<EnrollData | null>(null);
  const enrollStarted = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Which sign-in methods are enabled (drives what the page offers).
  const [ldapEnabled, setLdapEnabled] = useState(false);
  const [ssoEnabled, setSsoEnabled] = useState(false);

  useEffect(() => {
    listAuthSettings()
      .then((rows) => {
        setLdapEnabled(rows.some((r) => r.method === 'ldap' && r.enabled));
        setSsoEnabled(rows.some((r) => (r.method === 'sso' || r.method === 'oidc') && r.enabled));
      })
      .catch(() => { /* settings unreadable pre-auth: show local only */ });
  }, []);

  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const needsTotp = !loading && session !== null && mfaPending;
  const needsEnroll = !loading && session !== null && mfaEnrollRequired;

  // MFA is mandatory: as soon as a factor-less session lands here, start enrollment.
  useEffect(() => {
    if (!needsEnroll || enrollStarted.current) return;
    enrollStarted.current = true;
    (async () => {
      const { data: existing } = await supabase.auth.mfa.listFactors();
      for (const f of existing?.all ?? []) {
        if (f.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
      const { data, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'Authenticator app',
      });
      if (enrollError || !data) {
        setError(enrollError?.message ?? 'Could not start MFA enrollment.');
        enrollStarted.current = false;
        return;
      }
      setEnrollData({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
    })();
  }, [needsEnroll]);

  if (!loading && session && !mfaPending && !mfaEnrollRequired) return <Navigate to={from} replace />;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    // Default flow: try the local account first (the administrator + any local
    // user). If that fails and LDAP is enabled, authenticate the SAME
    // credentials against the directory - no separate button/step.
    const { error: signInError } = await signIn(email.trim(), password);
    if (!signInError) {
      setSubmitting(false);
      return; // AuthProvider updates and the render below routes (MFA / redirect).
    }
    if (ldapEnabled) {
      try {
        await ldapSignIn(email.trim(), password);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
      return;
    }
    setSubmitting(false);
    setError(signInError === 'Invalid login credentials' ? 'Invalid email or password.' : signInError);
  };

  const handleTotpSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
    const factor = factors?.totp.find((f) => f.status === 'verified');
    if (listError || !factor) {
      setSubmitting(false);
      setError(listError?.message ?? 'No authenticator enrolled for this account.');
      return;
    }
    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
      factorId: factor.id,
      code: totpCode.trim(),
    });
    setSubmitting(false);
    if (verifyError) {
      setError('Invalid code - check your authenticator app and try again.');
      return;
    }
    await refreshMfa();
    navigate(from, { replace: true });
  };

  const handleEnrollSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!enrollData) return;
    setError(null);
    setSubmitting(true);
    const { data: ch, error: chError } = await supabase.auth.mfa.challenge({ factorId: enrollData.factorId });
    if (chError || !ch) {
      setSubmitting(false);
      setError(chError?.message ?? 'Challenge failed.');
      return;
    }
    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId: enrollData.factorId,
      challengeId: ch.id,
      code: totpCode.trim(),
    });
    setSubmitting(false);
    if (verifyError) {
      setError('Invalid code - check your authenticator app and try again.');
      return;
    }
    await refreshMfa();
    navigate(from, { replace: true });
  };

  const handleSso = async () => {
    setError(null);
    setSubmitting(true);
    // Keycloak (LDAP-federated) OIDC. Front-channel and back-channel both key to
    // the tunnel public URL, so redirect back to wherever we're being served.
    const { error: ssoError } = await supabase.auth.signInWithOAuth({
      provider: 'keycloak',
      options: { redirectTo: window.location.origin + '/' },
    });
    if (ssoError) {
      setSubmitting(false);
      setError(ssoError.message);
    }
    // On success the browser is navigated away to Keycloak; nothing more to do.
  };

  const backToLogin = async () => {
    setTotpCode('');
    setEnrollData(null);
    enrollStarted.current = false;
    setError(null);
    await signOut();
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden px-4" style={{ backgroundColor: 'var(--s-bg)' }}>
      {/* Brand gradient glow */}
      <div className="absolute -top-40 -left-40 w-96 h-96 rounded-full bg-brand-purple/25 blur-3xl pointer-events-none" />
      <div className="absolute -bottom-40 -right-40 w-96 h-96 rounded-full bg-brand-magenta/20 blur-3xl pointer-events-none" />

      {/* Theme toggle */}
      <button
        onClick={toggle}
        className="absolute top-5 right-5 p-2 rounded-lg transition-all duration-200 hover:scale-105"
        style={{ color: 'var(--s-muted)' }}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {theme === 'dark' ? <Sun className="w-[18px] h-[18px]" /> : <Moon className="w-[18px] h-[18px]" />}
      </button>

      <div className="glass-card w-full max-w-md p-6 sm:p-8 relative">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <img src="/assets/media-logo.png" alt="Soteria" className="w-16 h-16 rounded-xl object-contain mb-4" />
          <h1 className="text-2xl font-bold tracking-wide heading">SOTERIA</h1>
          <p className="text-xs font-medium tracking-widest uppercase mt-1" style={{ color: 'var(--s-muted)' }}>
            TACACS+ Management
          </p>
        </div>

        {needsEnroll ? (
          <form onSubmit={handleEnrollSubmit} className="space-y-4">
            {error && (
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {error}
              </div>
            )}

            <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-brand-purple/10 border border-brand-purple/20 text-sm" style={{ color: 'var(--s-text)' }}>
              <ShieldCheck className="w-4 h-4 shrink-0 text-brand-magenta" />
              Two-factor authentication is required. Scan the QR code with an
              authenticator app, then enter the 6-digit code.
            </div>

            {enrollData ? (
              <>
                <div className="flex justify-center">
                  <div className="p-3 rounded-xl bg-white">
                    <img src={qrSrc(enrollData.qrCode)} alt="TOTP QR code" className="w-40 h-40" />
                  </div>
                </div>
                <div className="config-preview text-center select-all" title="Manual entry secret">
                  {enrollData.secret}
                </div>
                <div>
                  <label htmlFor="enroll-code" className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>
                    Verification Code
                  </label>
                  <input
                    id="enroll-code"
                    type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}"
                    required maxLength={6} autoFocus value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                    className="input-field font-mono text-center text-lg tracking-[0.5em]"
                    placeholder="000000"
                  />
                </div>
                <button type="submit" disabled={submitting || totpCode.length !== 6} className="btn-primary w-full flex items-center justify-center gap-2 py-2.5 mt-2">
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                  {submitting ? 'Verifying…' : 'Activate & Continue'}
                </button>
              </>
            ) : !error && (
              <div className="flex justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-brand-magenta" />
              </div>
            )}

            <button type="button" onClick={backToLogin} className="btn-ghost w-full flex items-center justify-center gap-2 text-sm">
              <ArrowLeft className="w-4 h-4" /> Back to sign in
            </button>
          </form>
        ) : needsTotp ? (
          <form onSubmit={handleTotpSubmit} className="space-y-4">
            {error && (
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {error}
              </div>
            )}

            <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-brand-purple/10 border border-brand-purple/20 text-sm" style={{ color: 'var(--s-text)' }}>
              <ShieldCheck className="w-4 h-4 shrink-0 text-brand-magenta" />
              Enter the 6-digit code from your authenticator app.
            </div>

            <div>
              <label htmlFor="totp" className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>
                Verification Code
              </label>
              <input
                id="totp"
                type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}"
                required maxLength={6} autoFocus value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                className="input-field font-mono text-center text-lg tracking-[0.5em]"
                placeholder="000000"
              />
            </div>

            <button type="submit" disabled={submitting || totpCode.length !== 6} className="btn-primary w-full flex items-center justify-center gap-2 py-2.5 mt-2">
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              {submitting ? 'Verifying…' : 'Verify'}
            </button>

            <button type="button" onClick={backToLogin} className="btn-ghost w-full flex items-center justify-center gap-2 text-sm">
              <ArrowLeft className="w-4 h-4" /> Back to sign in
            </button>
          </form>
        ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          <div>
            <label htmlFor="email" className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>
              {ldapEnabled ? 'Email or username' : 'Email'}
            </label>
            <div className="relative">
              <Mail className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--s-muted)' }} />
              <input
                id="email"
                type={ldapEnabled ? 'text' : 'email'}
                autoComplete="username"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input-field pl-9"
                placeholder={ldapEnabled ? 'admin@soteria.lab or directory username' : 'admin@soteria.lab'}
              />
            </div>
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>
              Password
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--s-muted)' }} />
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input-field pl-9 pr-10"
                placeholder="••••••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                style={{ color: 'var(--s-muted)' }}
                title={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <button type="submit" disabled={submitting} className="btn-primary w-full flex items-center justify-center gap-2 py-2.5 mt-2">
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
            {submitting ? 'Signing in…' : 'Sign In'}
          </button>

          {ssoEnabled && (
            <>
              <div className="flex items-center gap-3 pt-1" aria-hidden="true">
                <span className="h-px flex-1" style={{ backgroundColor: 'var(--s-border)' }} />
                <span className="text-xs uppercase tracking-widest" style={{ color: 'var(--s-muted)' }}>or</span>
                <span className="h-px flex-1" style={{ backgroundColor: 'var(--s-border)' }} />
              </div>
              <button
                type="button"
                onClick={handleSso}
                disabled={submitting}
                className="btn-ghost w-full flex items-center justify-center gap-2 py-2.5 border"
                style={{ borderColor: 'var(--s-border)' }}
              >
                <KeyRound className="w-4 h-4" /> Sign in with SSO
              </button>
            </>
          )}
          {ldapEnabled && (
            <p className="text-center text-xs" style={{ color: 'var(--s-muted)' }}>
              Directory (LDAP) accounts sign in above with their username and password.
            </p>
          )}
        </form>
        )}

        <p className="text-center text-xs mt-6" style={{ color: 'var(--s-muted)' }}>
          Pathfinder Project · Soteria TACACS+ Server
        </p>
      </div>
    </div>
  );
}
