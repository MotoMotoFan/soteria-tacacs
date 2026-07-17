import { supabaseAdmin } from './supabase';

// An Access Group (web-UI permission role). Distinct from the TACACS "User
// Groups" page. Stored in the Supabase `web_roles` table; its scopes are written
// into each member's app_metadata (which rides in their JWT) so the agent can
// enforce them offline.
export interface WebRole {
  id: string;
  name: string;
  scopes: string[];
  created_at?: string;
}

// Protected built-in groups (untouchable, like the admin account).
export const ADMIN_GROUP = 'Administrator';
export const READONLY_GROUP = 'Read Only';
export const PROTECTED_GROUPS = [ADMIN_GROUP, READONLY_GROUP];
export const isProtectedGroup = (name: string) => PROTECTED_GROUPS.includes(name);

function admin() {
  if (!supabaseAdmin) throw new Error('Admin API unavailable (service role key not configured)');
  return supabaseAdmin;
}

// Ensure the two protected groups exist. Administrator carries every scope (its
// members are admins and bypass scope checks anyway); Read Only carries every
// :read scope. Idempotent.
export async function ensureProtectedRoles(allScopes: string[]): Promise<void> {
  const existing = new Set((await listRoles()).map((r) => r.name));
  if (!existing.has(ADMIN_GROUP)) await createRole(ADMIN_GROUP, allScopes);
  if (!existing.has(READONLY_GROUP)) await createRole(READONLY_GROUP, allScopes.filter((s) => s.endsWith(':read')));
}

// The app_metadata payload for a user given their assigned group. Members of the
// Administrator group are admins (role=admin, full access); everyone else is
// limited to their group's scopes.
export function appMetadataForGroup(group: string, groupScopes: string[]): Record<string, unknown> {
  if (group === ADMIN_GROUP) return { role: 'admin', group: ADMIN_GROUP, scopes: null };
  return { role: null, group: group || null, scopes: group ? groupScopes : [] };
}

export async function listRoles(): Promise<WebRole[]> {
  const { data, error } = await admin().from('web_roles').select('*').order('name');
  if (error) throw new Error(error.message);
  return (data ?? []) as WebRole[];
}

export async function createRole(name: string, scopes: string[]): Promise<void> {
  const { error } = await admin().from('web_roles').insert({ name: name.trim(), scopes });
  if (error) throw new Error(error.message);
}

export async function updateRole(id: string, prevName: string, name: string, scopes: string[]): Promise<void> {
  const { error } = await admin().from('web_roles').update({ name: name.trim(), scopes }).eq('id', id);
  if (error) throw new Error(error.message);
  await syncMembers(prevName, name.trim(), scopes);
}

export async function deleteRole(id: string, name: string): Promise<void> {
  if (isProtectedGroup(name)) throw new Error(`"${name}" is a protected group and cannot be deleted`);
  const { error } = await admin().from('web_roles').delete().eq('id', id);
  if (error) throw new Error(error.message);
  await syncMembers(name, null, []); // unassign remaining members
}

// Re-apply a group's scopes to all of its member users (and handle rename or
// deletion by moving members to newName / clearing them).
async function syncMembers(prevName: string, newName: string | null, scopes: string[]): Promise<void> {
  const { data, error } = await admin().auth.admin.listUsers();
  if (error) throw new Error(error.message);
  for (const u of data.users) {
    const meta = (u.app_metadata ?? {}) as { role?: string; group?: string };
    if (meta.role === 'admin' || meta.group !== prevName) continue;
    await admin().auth.admin.updateUserById(u.id, {
      app_metadata: { role: null, group: newName, scopes: newName ? scopes : [] },
    });
  }
}

// The app_metadata payload for a user given the chosen role/group.
// Admin => full access (role=admin). Otherwise the group's scopes (or none).
export function userAppMetadata(
  role: 'admin' | 'user',
  group: string | null,
  groupScopes: string[],
): Record<string, unknown> {
  if (role === 'admin') return { role: 'admin', group: null, scopes: null };
  return { role: null, group: group || null, scopes: group ? groupScopes : [] };
}
