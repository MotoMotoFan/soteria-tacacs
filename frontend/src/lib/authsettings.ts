import { supabase, supabaseAdmin } from './supabase';
import { api } from './api';
import { listRoles, appMetadataForGroup, READONLY_GROUP } from './roles';

// Authentication method configuration, stored in the Supabase `auth_settings`
// table. Only `local` is wired end-to-end today; ldap/oidc/sso persist their
// config here and are enabled server-side (GoTrue) by an admin later.
export type AuthMethod = 'local' | 'ldap' | 'oidc' | 'sso';

export interface AuthSetting {
  method: AuthMethod;
  enabled: boolean;
  config: Record<string, string | boolean>;
}

function admin() {
  if (!supabaseAdmin) throw new Error('Admin API unavailable (service role key not configured)');
  return supabaseAdmin;
}

export async function listAuthSettings(): Promise<AuthSetting[]> {
  const { data, error } = await admin().from('auth_settings').select('*').order('method');
  if (error) throw new Error(error.message);
  return (data ?? []) as AuthSetting[];
}

export async function saveAuthSetting(method: AuthMethod, enabled: boolean, config: Record<string, string | boolean>): Promise<void> {
  const { error } = await admin()
    .from('auth_settings')
    .upsert({ method, enabled, config, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

/** Derive an email domain from a base DN, e.g. dc=example,dc=com -> example.com */
function domainFromBaseDn(baseDn: string): string {
  return baseDn.split(',').map((s) => s.trim())
    .filter((s) => s.toLowerCase().startsWith('dc='))
    .map((s) => s.slice(3)).join('.');
}

/**
 * Direct LDAP sign-in (no third-party bridge): the agent binds the directory
 * with the entered credentials; on success we provision/refresh a Supabase user
 * (marked auth_source=ldap, MFA-exempt) and open a passwordless session via an
 * admin-generated magic link. Group of the same name is synced when enabled,
 * otherwise the user lands in Read Only.
 */
export async function ldapSignIn(username: string, password: string): Promise<void> {
  const a = supabaseAdmin;
  if (!a) throw new Error('Admin API unavailable (service role key not configured).');

  const ldap = (await listAuthSettings()).find((s) => s.method === 'ldap');
  if (!ldap || !ldap.enabled) throw new Error('LDAP sign-in is not enabled.');

  const res = await api.ldapLogin(ldap.config, username.trim(), password);
  if (!res.ok) throw new Error(res.message || 'Directory authentication failed.');

  let email = (res.email || '').trim().toLowerCase();
  if (!email) {
    const domain = domainFromBaseDn(String(ldap.config.baseDn ?? '')) || 'ldap.local';
    email = `${username.trim().toLowerCase()}@${domain}`;
  }

  // Group mapping: sync a directory group of the same name, else Read Only.
  const roles = await listRoles();
  let group = READONLY_GROUP;
  if (ldap.config.syncGroups) {
    const names = new Set(roles.map((r) => r.name));
    const match = (res.groups ?? []).find((g) => names.has(g));
    if (match) group = match;
  }
  const scopes = roles.find((r) => r.name === group)?.scopes ?? [];
  const app_metadata = { ...appMetadataForGroup(group, scopes), auth_source: 'ldap' };
  const user_metadata = { full_name: res.displayName || username.trim() };

  const { data: list, error: listErr } = await a.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) throw new Error(listErr.message);
  const existing = list?.users.find((u) => (u.email ?? '').toLowerCase() === email);
  if (existing) {
    await a.auth.admin.updateUserById(existing.id, { app_metadata, user_metadata, ban_duration: 'none' });
  } else {
    await a.auth.admin.createUser({ email, email_confirm: true, app_metadata, user_metadata });
  }

  const { data: link, error: linkErr } = await a.auth.admin.generateLink({ type: 'magiclink', email });
  if (linkErr || !link) throw new Error(linkErr?.message ?? 'Could not start a session.');
  const tokenHash = (link.properties as { hashed_token?: string } | undefined)?.hashed_token;
  if (!tokenHash) throw new Error('Session link had no token.');
  const { error: otpErr } = await supabase.auth.verifyOtp({ type: 'magiclink', token_hash: tokenHash });
  if (otpErr) throw new Error(otpErr.message);
}

/**
 * Enforce the policy "an external method is enabled ⇒ local users are disabled,
 * except the Administrator". Bans (or unbans) every non-admin local (email)
 * user via GoTrue. External (SSO/OIDC/keycloak) users are never touched here.
 */
export async function enforceLocalUsers(disableNonAdmin: boolean): Promise<void> {
  const a = admin();
  const { data, error } = await a.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw new Error(error.message);
  for (const u of data.users) {
    const meta = (u.app_metadata ?? {}) as { role?: string; provider?: string; auth_source?: string };
    const provider = meta.provider ?? (u.identities?.[0]?.provider ?? 'email');
    const isExternal = provider !== 'email' || meta.auth_source === 'ldap';
    if (isExternal || meta.role === 'admin') continue; // never disable admins or external (SSO/LDAP) identities
    await a.auth.admin.updateUserById(u.id, { ban_duration: disableNonAdmin ? '876000h' : 'none' });
  }
}
