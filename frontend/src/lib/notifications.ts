// System notifications (agent / TACACS+ up-down events), persisted to
// localStorage so they survive reloads. Populated by TopBar's status poll
// when it detects a service state transition.

export interface SysNotification {
  id: string;
  ts: string; // ISO timestamp
  kind: 'up' | 'down' | 'warn';
  text: string;
  read: boolean;
}

const KEY = 'soteria-notifications';
const MAX = 50;

export function loadNotifications(): SysNotification[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function saveNotifications(list: SysNotification[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* storage full / unavailable - notifications are best-effort */
  }
}

export function makeNotification(kind: SysNotification['kind'], text: string): SysNotification {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    kind,
    text,
    read: false,
  };
}
