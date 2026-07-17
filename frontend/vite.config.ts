import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { defineConfig, loadEnv, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';

// ---------------------------------------------------------------------------
// Allowed-hosts management
//
// Vite blocks requests whose Host header isn't in `server.allowedHosts` (this is
// what produced "Blocked request. This host is not allowed" behind the
// Cloudflare tunnel). The list is data-driven from allowed-hosts.json, managed
// from the CLI (`npm run hosts -- add <domain>` etc.). There is deliberately NO
// HTTP endpoint for this: editing it requires shell access to the machine
// running the dev server, so there's nothing publicly exploitable. The dev
// server watches the file and restarts itself when it changes, so CLI edits
// apply live. In production (static build behind nginx/Cloudflare) this check
// doesn't exist - the reverse proxy governs which hosts are served.
// ---------------------------------------------------------------------------

const HOSTS_FILE = path.resolve(__dirname, 'allowed-hosts.json');

interface HostConfig {
  publicDomains: string[];
  localDomains: string[];
}

// Used when allowed-hosts.json is absent (fresh checkout).
const DEFAULT_HOSTS: HostConfig = {
  publicDomains: ['soteria.infra-sandbox.com', '.infra-sandbox.com'],
  localDomains: ['soteria.lab.home', '.lab.home'],
};

function loadHostConfig(): HostConfig {
  try {
    if (existsSync(HOSTS_FILE)) {
      const raw = JSON.parse(readFileSync(HOSTS_FILE, 'utf-8'));
      return {
        publicDomains: Array.isArray(raw.publicDomains) ? raw.publicDomains.map(String) : [],
        localDomains: Array.isArray(raw.localDomains) ? raw.localDomains.map(String) : [],
      };
    }
  } catch (e) {
    console.warn('[host-config] could not read', HOSTS_FILE, e);
  }
  return DEFAULT_HOSTS;
}

/** Flatten the config into the list Vite consumes; localhost is always allowed. */
function resolveAllowedHosts(cfg: HostConfig): string[] {
  return Array.from(
    new Set(
      [...cfg.publicDomains, ...cfg.localDomains, 'localhost', '127.0.0.1']
        .map((h) => h.trim())
        .filter(Boolean),
    ),
  );
}

// ---------------------------------------------------------------------------
// Mobile connection discovery (/connect-info.json)
//
// The Soteria mobile apps onboard with only a BASE URL (scanned as a small QR,
// or typed). They then fetch this public discovery doc to learn how to reach the
// backends and the PUBLIC Supabase anon key. Keeping the anon key here (served
// by the frontend, which already owns it as build-time env) rather than baking
// it into the QR keeps a single source of truth: rotate the key in one place and
// every device picks it up on next connect. This carries NO secret - the anon
// key is public by design (already in the JS bundle) and the service role key is
// never involved. Served in dev via middleware and emitted into the static build.
// ---------------------------------------------------------------------------

function connectInfoDoc(env: Record<string, string>): string {
  const doc = {
    v: 1,
    t: 'soteria-connect-info',
    brand: 'Soteria TACACS+',
    // Relative values (/agent, /supabase) are resolved by the app against the
    // origin it fetched this doc from; absolute values are used as-is.
    agentBaseUrl: (env.VITE_AGENT_URL ?? '/agent').replace(/\/$/, ''),
    supabaseUrl: env.VITE_SUPABASE_URL ?? '/supabase',
    supabaseAnonKey: env.VITE_SUPABASE_ANON_KEY ?? '',
  };
  return JSON.stringify(doc, null, 2);
}

function connectInfoPlugin(env: Record<string, string>): PluginOption {
  const json = connectInfoDoc(env);
  return {
    name: 'soteria-connect-info',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? '').split('?')[0] === '/connect-info.json') {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store'); // always fresh, so key rotation propagates
          res.setHeader('Access-Control-Allow-Origin', '*'); // public discovery; harmless (anon key is public)
          res.end(json);
          return;
        }
        next();
      });
    },
    // Emit into the static build so the same discovery doc exists in production
    // (served by the fronting reverse proxy) as in dev.
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'connect-info.json', source: json });
    },
  };
}

/** Restart the dev server when allowed-hosts.json changes so CLI edits apply. */
function hostConfigWatcher(): PluginOption {
  return {
    name: 'soteria-host-config-watch',
    configureServer(server) {
      server.watcher.add(HOSTS_FILE);
      server.watcher.on('change', (file) => {
        if (path.resolve(file) === HOSTS_FILE) {
          server.config.logger.info('[host-config] allowed-hosts.json changed, restarting dev server...');
          void server.restart();
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // All env (not just VITE_-prefixed) so the connect-info plugin can read the
  // Supabase/agent values; only VITE_ ones reach the client bundle as usual.
  const env = loadEnv(mode, process.cwd(), '');
  return {
  server: {
    port: 3000,
    host: '0.0.0.0',
    // Hostnames allowed to reach the dev server. Managed from the CLI
    // (`npm run hosts`), persisted to allowed-hosts.json. Vite blocks any other Host.
    allowedHosts: resolveAllowedHosts(loadHostConfig()),
    // Same-origin proxy so a browser reaching us over a public tunnel never has
    // to touch the lab-only backends directly (they resolve/trust only inside
    // the lab, and http:// would be blocked as mixed content on the https page).
    // The frontend uses relative URLs (/supabase, /agent); Vite forwards them
    // server-side. No extra tunnel routes, no CORS.
    proxy: {
      '/agent': {
        target: 'http://192.168.1.160:8081',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/agent/, ''),
      },
      '/supabase': {
        target: 'http://192.168.1.160:8100', // Supabase Kong gateway (http)
        changeOrigin: true,
        ws: true, // realtime websockets
        rewrite: (p) => p.replace(/^\/supabase/, ''),
      },
      // Keycloak IdP (for SSO/OIDC login). Keycloak serves under /keycloak
      // (KC_HTTP_RELATIVE_PATH), so no rewrite; xfwd forwards the real
      // Host/proto so Keycloak builds correct public URLs behind the tunnel.
      '/keycloak': {
        target: 'http://192.168.1.160:8180',
        changeOrigin: true,
        xfwd: true,
      },
    },
  },
  plugins: [react(), hostConfigWatcher(), connectInfoPlugin(env)],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  };
});
