// =============================================================================
// soteria-agent API client - the single source of entity data.
// Types mirror the agent's Go structs (soteria-agent/internal/model).
// =============================================================================
import { supabase } from './supabase';

// ---- Entity types (mirror soteria-agent/internal/model/model.go) ----

export interface Device {
  name: string;
  address: string; // CIDR
  platform: string;
  keyType: 'global' | 'custom' | 'group'; // group = inherited from the device group
  key?: string;
  /** Parent device group (tac_plus-ng `parent = name`), if any. */
  group?: string;
  lastSeen: string;
  status: 'online' | 'offline' | 'unknown';
}

/** Address-less parent device block; members inherit its key via `parent =`. */
export interface DeviceGroup {
  name: string;
  description?: string;
  keyType: 'global' | 'custom';
  key?: string;
  members: number; // derived, read-only
}

export interface User {
  name: string;
  group: string;
  authSource: 'local' | 'ldap';
  lastLogin: string;
  status: 'active' | 'locked' | 'disabled';
  /** Write-only: set on PUT to create/change a password. Never returned. */
  password?: string;
}

export interface Group {
  name: string;
  members: number;
  source: 'local' | 'ldap';
  profile: string;
}

export interface ConditionRule {
  attribute: string;
  operator: string;
  value: string;
  actions: string[];
  inline: boolean;
  inlineAction: string;
  defaultAction: string;
}

export interface ServiceRule {
  service: string;
  actions: string[]; // direct set actions (Juniper style)
  conditions: ConditionRule[];
  defaultAction: string;
}

export interface Profile {
  name: string;
  services: ServiceRule[];
  defaultAction: string;
}

export interface RuleCondition {
  attribute: string;
  operator: string;
  value: string;
  actions: string[];
  children: RuleCondition[];
  elseActions: string[];
  elseAction: string;
  defaultAction: string;
}

/** One rule {} block inside ruleset {}. */
export interface Rule {
  enabled: boolean;
  matches: RuleCondition[];
  defaultAction: string;
}

export interface LogEntry {
  timestamp: string;
  type: 'authentication' | 'authorization' | 'accounting';
  user: string;
  device: string;
  deviceIp: string;
  result: 'success' | 'failure' | 'error';
  port?: string;    // NAS line/tty (vty4, con0)
  service?: string; // TACACS+ service (shell, …) - authz/acct
  command?: string; // authorized/accounted command - authz/acct
  detail: string;
}

export interface ConfigBackup {
  id: string;
  timestamp: string;
  size: string;
  files: number;
}

export interface ConfigFile {
  name: string; // e.g. "conf.d/04-devices.cfg"
  size: number;
  modified: string;
}

export interface ServiceStatus {
  online: boolean;
  health?: string; // healthy | unhealthy | starting | unknown
  startedAt?: string;
  uptime?: string;
}

export interface SystemStatus {
  agent: ServiceStatus;
  tacacs: ServiceStatus;
}

export interface ToolResult {
  success: boolean;
  verdict: string; // OK | FAIL | PERMIT | DENY | ERROR
  message: string;
  attributes?: string[];
  latencyMs: number;
}

export interface PingResult {
  success: boolean;
  output: string;
  latencyMs: number;
}

export interface TraceResult {
  verdict: string; // PERMIT | DENY | ERROR | UNKNOWN
  output: string;
  latencyMs: number;
}

/** One file of the shared LDAP TLS bundle (ca / client-cert / client-key). */
export interface LdapCertInfo {
  name: 'ca' | 'client-cert' | 'client-key';
  present: boolean;
  subject?: string;
  issuer?: string;
  notBefore?: string;
  notAfter?: string;
  expired?: boolean;
  error?: string;
}

export interface CommitResponse {
  status: string;
  file?: string;
  validatorOutput?: string;
}

export interface StagingInfo {
  active: boolean;
  changedFiles: string[];
  retention: number;
  restartRequired?: boolean; // committing will restart the tac_plus container
}

export interface FileDiff {
  file: string;
  diff: string;
}

export interface GoldenInfo {
  exists: boolean;
  savedAt?: string;
  files?: number;
  size?: string;
}

/** 01-logging.cfg model. Local files and syslog export are independent toggles. */
export interface LoggingConfig {
  fileLogEnabled: boolean; // daily files (the AAA Logs page reads these)
  syslogEnabled: boolean;
  syslogHost: string;
  syslogPort: number;
  syslogTimestamp: string; // "RFC3164" (Wazuh/BSD) | "RFC5424"
}

/** Full TACACS+ server settings. LDAP/DNS apply live; the rest need a restart. */
export interface ServerSettings {
  sharedKey?: string;
  sharedKeySet: boolean;
  ldapEnabled: boolean;
  ldapServerType: string;
  ldapHosts: string;
  ldapUser: string;
  ldapPassword?: string;
  ldapPasswordSet: boolean;
  ldapBase: string;
  ldapFilter: string;
  ldapBaseGroup: string;
  ldapFilterGroup: string;
  ldapTacMember: string;
  ldapConnectTimeout: string;
  /** "none" | "ldaps" | "starttls" */
  ldapTlsMode: string;
  /** Validate the directory's server certificate against the uploaded CA. */
  ldapTlsVerify: boolean;
  dnsServer: string;
  dnsReverseLookup: boolean;
  dnsTimeout: string;
  listenPort: string;
  timezone: string;
  tlsEnabled: boolean;
  tlsPort: string;
  logrotate: boolean;
  monthlyArchive: boolean;
}

/** Maps a managed config file to the UI section it belongs to. */
export const FILE_SECTIONS: Record<string, string> = {
  'conf.d/01-logging.cfg': 'System - AAA Logging',
  'conf.d/04-devices.cfg': 'Device Management',
  'conf.d/05-local-users.cfg': 'User Management - Users',
  'conf.d/06-groups.cfg': 'User Management - Groups',
  'conf.d/07-profiles.cfg': 'Access Control - Profiles',
  'conf.d/08-ruleset.cfg': 'Access Control - Rulesets',
};

// ---- Client ----

export class ApiError extends Error {
  validatorOutput?: string;
  status: number;
  constructor(message: string, status: number, validatorOutput?: string) {
    super(message);
    this.status = status;
    this.validatorOutput = validatorOutput;
  }
}

const BASE = ((import.meta.env.VITE_AGENT_URL as string | undefined) ?? '').replace(/\/$/, '');

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!BASE) {
    throw new ApiError(
      'VITE_AGENT_URL is not set - add it to .env.local (e.g. http://192.168.1.160:8081)',
      0,
    );
  }
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // Attach the Supabase session JWT; the agent verifies it when
  // AGENT_JWT_SECRET is configured (no-op otherwise).
  const { data } = await supabase.auth.getSession();
  if (data.session?.access_token) headers['Authorization'] = `Bearer ${data.session.access_token}`;

  let resp: Response;
  try {
    resp = await fetch(BASE + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(`Cannot reach soteria-agent at ${BASE} - is the container running?`, 0);
  }

  // Any successful write may change staging state - let ConfigModeProvider know.
  if (resp.ok && method !== 'GET') {
    window.dispatchEvent(new Event('soteria:staging-changed'));
  }

  const text = await resp.text();
  if (!resp.ok) {
    let message = `${resp.status} ${resp.statusText}`;
    let validatorOutput: string | undefined;
    try {
      const parsed = JSON.parse(text) as { error?: string; validatorOutput?: string };
      if (parsed.error) message = parsed.error;
      validatorOutput = parsed.validatorOutput;
    } catch {
      if (text) message = text;
    }
    throw new ApiError(message, resp.status, validatorOutput);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

async function requestRaw(path: string): Promise<string> {
  if (!BASE) throw new ApiError('VITE_AGENT_URL is not set', 0);
  const headers: Record<string, string> = {};
  const { data } = await supabase.auth.getSession();
  if (data.session?.access_token) headers['Authorization'] = `Bearer ${data.session.access_token}`;
  const resp = await fetch(BASE + path, { headers });
  if (!resp.ok) throw new ApiError(`${resp.status} ${resp.statusText}`, resp.status);
  return resp.text();
}

// API tokens: long-lived scoped credentials for programmatic access. The
// secret is returned only once (at creation); records carry a masked preview.
export interface ApiToken {
  id: string;
  name: string;
  owner: string;
  scopes: string[];
  preview: string;
  created: number;
  expires: number; // unix seconds; 0 = never
  lastUsed: number; // unix seconds; 0 = never used
  revoked: boolean;
}

export interface ApiScope {
  scope: string;
  method: string;
  path: string;
  description: string;
}

// DNS (authoritative zones on the local BIND9, managed via the agent).
export interface DnsRecord {
  name: string; // owner relative to the zone: "tacacs", "@", or "160" (reverse octet)
  type: string; // A | AAAA | CNAME | TXT | NS | MX | PTR | SRV
  ttl?: number;
  value: string;
}

export interface DnsZone {
  name: string;
  kind: 'forward' | 'reverse';
  network?: string; // derived for reverse zones, e.g. "192.168.1.0/24"
  primaryNs: string;
  admin: string;
  serial: number;
  ttl: number;
  records: DnsRecord[];
}

export const api = {
  // Entities - GET returns current config state, PUT replaces the whole
  // collection and runs the agent's commit pipeline (backup → validate →
  // reload; rejected commits leave the live config untouched).
  getDevices: () => request<Device[]>('GET', '/api/devices'),
  saveDevices: (devices: Device[]) => request<CommitResponse>('PUT', '/api/devices', devices),
  getDeviceGroups: () => request<DeviceGroup[]>('GET', '/api/device-groups'),
  saveDeviceGroups: (groups: DeviceGroup[]) => request<CommitResponse>('PUT', '/api/device-groups', groups),
  getUsers: () => request<User[]>('GET', '/api/users'),
  saveUsers: (users: User[]) => request<CommitResponse>('PUT', '/api/users', users),
  getGroups: () => request<Group[]>('GET', '/api/groups'),
  saveGroups: (groups: Group[]) => request<CommitResponse>('PUT', '/api/groups', groups),
  getProfiles: () => request<Profile[]>('GET', '/api/profiles'),
  saveProfiles: (profiles: Profile[]) => request<CommitResponse>('PUT', '/api/profiles', profiles),
  getRules: () => request<Rule[]>('GET', '/api/rulesets'),
  saveRules: (rules: Rule[]) => request<CommitResponse>('PUT', '/api/rulesets', rules),

  // Logs - inclusive date range YYYY-MM-DD (each defaults to today on the
  // agent side). Pass a single day by giving from === to.
  getLogs: (from?: string, to?: string, type?: string) => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (type) params.set('type', type);
    const qs = params.toString();
    return request<LogEntry[]>('GET', `/api/logs${qs ? `?${qs}` : ''}`);
  },

  // AAA logging config (staged like entity saves)
  getLogging: () => request<LoggingConfig>('GET', '/api/config/logging'),
  saveLogging: (cfg: LoggingConfig) => request<CommitResponse>('PUT', '/api/config/logging', cfg),
  // Env-managed server settings (TLS/LDAP/DNS/rotation) - read-only reference
  getServerInfo: () => request<unknown>('GET', '/api/config/server-info'),
  // Editable server settings (LDAP + DNS apply live; staged like entity saves)
  getServerSettings: () => request<ServerSettings>('GET', '/api/config/settings'),
  saveServerSettings: (s: ServerSettings) => request<CommitResponse>('PUT', '/api/config/settings', s),

  // Staging (Edit Config mode) - entity PUTs stage; commit applies all at once
  getStaging: () => request<StagingInfo>('GET', '/api/staging'),
  beginStaging: () => request<{ status: string }>('POST', '/api/staging'),
  discardStaging: () => request<{ status: string }>('DELETE', '/api/staging'),
  commitStaging: () => request<CommitResponse>('POST', '/api/staging/commit'),
  getStagingDiff: () => request<FileDiff[]>('GET', '/api/staging/diff'),

  // Golden config (protected baseline; save is admin-only server-side)
  getGolden: () => request<GoldenInfo>('GET', '/api/config/golden'),
  saveGolden: () => request<{ status: string; golden: GoldenInfo }>('PUT', '/api/config/golden'),
  restoreGolden: () => request<CommitResponse>('POST', '/api/config/golden/restore'),
  getGoldenDiff: () => request<FileDiff[]>('GET', '/api/config/golden/diff'),

  // Config files & backups
  getConfigFiles: () => request<ConfigFile[]>('GET', '/api/config/files'),
  getConfigFileRaw: (name: string) => requestRaw(`/api/config/files/${name}`),
  getBackups: () => request<ConfigBackup[]>('GET', '/api/config/backups'),
  /** files empty/omitted = full (global) rollback; otherwise per-section. */
  restoreBackup: (id: string, files?: string[]) =>
    request<CommitResponse>('POST', `/api/config/backups/${id}/restore`, files?.length ? { files } : undefined),
  /** What restoring the backup would change (live → backup); file narrows to one config file. */
  getBackupDiff: (id: string, file?: string) =>
    request<FileDiff[]>('GET', `/api/config/backups/${id}/diff${file ? `?file=${encodeURIComponent(file)}` : ''}`),
  setRetention: (retention: number) => request<{ status: string; retention: number }>('PUT', '/api/config/retention', { retention }),
  validateConfig: () => request<{ status: string; output: string }>('POST', '/api/config/validate'),
  reloadConfig: () => request<{ status: string }>('POST', '/api/config/reload'),

  // Diagnostic tools - all run inside the TACACS server container
  authTest: (username: string, password: string) =>
    request<ToolResult>('POST', '/api/tools/auth-test', { username, password }),
  authzTest: (username: string, service: string, command: string) =>
    request<ToolResult>('POST', '/api/tools/authz-test', { username, service, command }),
  pingTest: (target: string, count: number) =>
    request<PingResult>('POST', '/api/tools/ping', { target, count }),
  traceTest: (mode: string, username: string, password: string, service: string, command: string, group: string) =>
    request<TraceResult>('POST', '/api/tools/trace', { mode, username, password, service, command, group }),

  // API tokens (managed via a web session; API tokens cannot mint tokens)
  listApiTokens: () => request<ApiToken[]>('GET', '/api/tokens'),
  listApiScopes: () => request<ApiScope[]>('GET', '/api/tokens/scopes'),
  createApiToken: (body: { name: string; scopes: string[]; expiresInDays: number; expiresAt: number }) =>
    request<{ token: ApiToken; secret: string }>('POST', '/api/tokens', body),
  revokeApiToken: (id: string) => request<{ status: string }>('DELETE', `/api/tokens/${id}`),

  // DNS management (local BIND9 via the agent; PUT records replaces the whole set)
  listDnsZones: () => request<DnsZone[]>('GET', '/api/dns/zones'),
  getDnsZone: (name: string) => request<DnsZone>('GET', `/api/dns/zones/${encodeURIComponent(name)}`),
  createDnsZone: (zone: { name: string; primaryNs?: string; admin?: string }) =>
    request<{ status: string; zone: string }>('POST', '/api/dns/zones', zone),
  deleteDnsZone: (name: string) => request<{ status: string }>('DELETE', `/api/dns/zones/${encodeURIComponent(name)}`),
  saveDnsRecords: (name: string, records: DnsRecord[]) =>
    request<{ status: string }>('PUT', `/api/dns/zones/${encodeURIComponent(name)}/records`, records),

  // NetBox source-of-truth scans (create reverse zones from tagged prefixes;
  // sync a zone's records from NetBox IPs).
  // dryRun=true previews the plan (creates/changes nothing); false applies it.
  scanReverseZones: (tag: string, dryRun: boolean) =>
    request<{ dryRun: boolean; scannedPrefixes: number; toCreate: string[]; existing: string[]; skipped: string[]; created: string[]; errors: string[] }>(
      'POST', '/api/dns/sot/reverse-zones', { tag, dryRun }),
  syncZoneFromSot: (name: string, tag: string, domain: string, dryRun: boolean) =>
    request<{ dryRun: boolean; added: DnsRecord[]; updated: DnsRecord[]; skipped: number }>(
      'POST', `/api/dns/zones/${encodeURIComponent(name)}/sot-sync`, { tag, domain, dryRun }),

  // LDAP config tests (admin only; the agent binds to the directory)
  testLdapConnection: (config: Record<string, string | boolean>) =>
    request<{ ok: boolean; message: string }>('POST', '/api/auth/ldap/test-connection', { config }),
  testLdapUser: (config: Record<string, string | boolean>, username: string, password: string) =>
    request<{ ok: boolean; dn?: string; groups: string[] | null; message: string; trace?: string[] }>('POST', '/api/auth/ldap/test-user', { config, username, password }),
  // Tri-state health of the TACACS+ MAVIS LDAP backend (binds live server config).
  ldapHealth: () =>
    request<{ enabled: boolean; connected: boolean; message: string }>('GET', '/api/auth/ldap/health'),
  // Shared LDAP TLS bundle: one CA + client cert/key used by BOTH the TACACS+
  // MAVIS backend and the web UI LDAP sign-in (same file paths in both containers).
  getLdapCerts: () => request<LdapCertInfo[]>('GET', '/api/config/ldap/certs'),
  uploadLdapCert: (name: string, pem: string) =>
    request<{ status: string }>('PUT', `/api/config/ldap/certs/${name}`, { pem }),
  deleteLdapCert: (name: string) =>
    request<{ status: string }>('DELETE', `/api/config/ldap/certs/${name}`),
  // Test bind / user against the TACACS Settings (MAVIS) LDAP form values.
  // A blank bind password falls back to the stored one server-side.
  testMavisLdapConnection: (config: ServerSettings) =>
    request<{ ok: boolean; message: string }>('POST', '/api/auth/ldap/mavis-test-connection', { config }),
  testMavisLdapUser: (config: ServerSettings, username: string, password: string) =>
    request<{ ok: boolean; dn?: string; groups: string[] | null; message: string; trace?: string[] }>(
      'POST', '/api/auth/ldap/mavis-test-user', { config, username, password }),
  // Public pre-auth LDAP login (validates directory credentials via the agent).
  ldapLogin: (config: Record<string, string | boolean>, username: string, password: string) =>
    request<{ ok: boolean; dn?: string; email?: string; displayName?: string; groups: string[] | null; message: string }>(
      'POST', '/api/auth/ldap/login', { config, username, password }),

  // Agent + TACACS server status (uptime, container health)
  getStatus: () => request<SystemStatus>('GET', '/api/status'),

  // Health (no auth required)
  ready: async (): Promise<boolean> => {
    if (!BASE) return false;
    try {
      const resp = await fetch(`${BASE}/ready`);
      return resp.ok;
    } catch {
      return false;
    }
  },
};
