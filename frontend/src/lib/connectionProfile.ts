// Builds the tiny "connect" payload the Soteria mobile apps import (by QR scan
// or manual entry). It carries ONLY this environment's base URL - no keys, no
// session. The app then fetches `<baseUrl>/connect-info.json` (served by the
// frontend, see vite.config.ts) to discover the agent + Supabase URLs and the
// PUBLIC Supabase anon key. This keeps a single source of truth for the anon
// key (rotate it once, every device picks it up) and keeps the QR small.
//
// Contract frozen in soteria-android/docs/04-connection-onboarding.md (§3).

export interface ConnectPayload {
  /** payload schema version */
  v: 1;
  /** discriminator so a scanner can reject non-Soteria QR codes */
  t: 'soteria-connect';
  /** the origin the app connects to and discovers config from */
  baseUrl: string;
  label: string;
  brand: string;
  issuedAt: string;
}

/** Shape of `<baseUrl>/connect-info.json` (for reference / typing a fetch). */
export interface ConnectInfo {
  v: 1;
  t: 'soteria-connect-info';
  brand: string;
  agentBaseUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export function buildConnectPayload(label?: string): ConnectPayload {
  return {
    v: 1,
    t: 'soteria-connect',
    baseUrl: window.location.origin,
    label: (label && label.trim()) || defaultLabel(),
    brand: 'Soteria TACACS+',
    issuedAt: new Date().toISOString(),
  };
}

/** A sensible default environment label from the host (e.g. "Soteria" from soteria.infra-sandbox.com). */
function defaultLabel(): string {
  const host = window.location.hostname || 'Soteria';
  const first = host.split('.')[0];
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : 'Soteria';
}

/** Compact JSON the mobile app parses (raw QR form). */
export function payloadToJson(payload: ConnectPayload): string {
  return JSON.stringify(payload);
}

/** Deep-link form: `soteria://connect?url=<baseUrl>`. A camera app that handles
 *  the scheme can open the app straight to onboarding. The app also accepts the
 *  raw JSON form and a bare https base URL. */
export function payloadToDeepLink(payload: ConnectPayload): string {
  return `soteria://connect?url=${encodeURIComponent(payload.baseUrl)}`;
}
