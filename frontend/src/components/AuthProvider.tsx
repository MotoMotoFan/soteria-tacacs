import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  isAdmin: boolean;
  loading: boolean;
  /** Session is password-only (aal1) but the user has a verified TOTP factor - the code step is still owed. */
  mfaPending: boolean;
  /** Session exists but the user has no verified TOTP factor - MFA is mandatory, so enrollment is owed. */
  mfaEnrollRequired: boolean;
  refreshMfa: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Derive MFA state synchronously from the session itself (JWT `aal` claim +
// user.factors) - an async lookup here opens a window where a guard renders
// before the state is known and the app briefly lets an aal1 session through.
function computeMfa(s: Session | null): { pending: boolean; enroll: boolean } {
  if (!s) return { pending: false, enroll: false };
  // External identities (LDAP direct login, Keycloak/OIDC/SAML SSO) authenticate
  // against their own directory/IdP, so the app's mandatory TOTP does not apply.
  const meta = (s.user.app_metadata ?? {}) as { provider?: string; auth_source?: string };
  if (meta.auth_source === 'ldap' || (meta.provider && meta.provider !== 'email')) {
    return { pending: false, enroll: false };
  }
  let aal = 'aal1';
  try {
    const payload = s.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    aal = (JSON.parse(atob(payload)) as { aal?: string }).aal ?? 'aal1';
  } catch { /* malformed token - treat as aal1 */ }
  if (aal === 'aal2') return { pending: false, enroll: false };
  const hasVerified = (s.user.factors ?? []).some((f) => f.status === 'verified');
  return { pending: hasVerified, enroll: !hasVerified };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [mfaPending, setMfaPending] = useState(false);
  const [mfaEnrollRequired, setMfaEnrollRequired] = useState(false);
  const [loading, setLoading] = useState(true);

  const applySession = useCallback((s: Session | null) => {
    setSession(s);
    const { pending, enroll } = computeMfa(s);
    setMfaPending(pending);
    setMfaEnrollRequired(enroll);
  }, []);

  // For explicit recalcs outside the auth-event callback (e.g. right after a
  // factor is verified, before the refreshed session event lands).
  const refreshMfa = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    applySession(data.session);
  }, [applySession]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      applySession(data.session);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, newSession) => {
      applySession(newSession);
    });

    return () => subscription.unsubscribe();
  }, [applySession]);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error ? error.message : null };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  const user = session?.user ?? null;
  const isAdmin = (user?.app_metadata as { role?: string } | undefined)?.role === 'admin';

  return (
    <AuthContext.Provider value={{ session, user, isAdmin, loading, mfaPending, mfaEnrollRequired, refreshMfa, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
