import { createClient } from '@supabase/supabase-js';

const rawUrl = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!rawUrl || !anonKey) {
  throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY - copy .env.example to .env.local (values live in OpenBao under soteria-app/supabase)');
}

// A relative value (e.g. "/supabase") is resolved against the current origin so
// the browser only ever talks to the host it loaded from - the Vite dev server
// (or a reverse proxy) forwards /supabase to the Kong gateway. supabase-js needs
// an absolute URL, so we build one from window.location.
const url = rawUrl.startsWith('/') ? window.location.origin + rawUrl : rawUrl;

export const supabase = createClient(url, anonKey, {
  auth: { storageKey: 'soteria-auth' },
});

// Lab-only: the service_role key in the browser lets the admin manage web users
// without a backend. Never do this outside a test environment.
const serviceRoleKey = import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY as string | undefined;

export const supabaseAdmin = serviceRoleKey
  ? createClient(url, serviceRoleKey, {
      auth: { storageKey: 'soteria-admin', persistSession: false, autoRefreshToken: false },
    })
  : null;
