import { useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Smartphone, Copy, Check, ChevronDown, ChevronUp, ShieldCheck } from 'lucide-react';
import { buildConnectPayload, payloadToJson } from '../lib/connectionProfile';

// Settings card: renders a QR code the Soteria mobile apps scan to connect to
// this environment. The QR carries ONLY this server's base URL - no key, no
// session. The app then fetches <baseUrl>/connect-info.json for the rest
// (docs/04). Config-only; the phone still signs in with MFA.
export default function ConnectMobileSection() {
  const payload = useMemo(() => buildConnectPayload(), []);
  const [showDetails, setShowDetails] = useState(false);
  const [copied, setCopied] = useState<'url' | 'payload' | null>(null);

  const copy = async (kind: 'url' | 'payload', text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      /* clipboard unavailable; the visible text can be selected manually */
    }
  };

  const json = payloadToJson(payload);

  return (
    <div className="glass-card p-6">
      <div className="flex items-center gap-3 mb-1">
        <div className="w-9 h-9 rounded-lg bg-brand-purple/15 flex items-center justify-center">
          <Smartphone className="w-[18px] h-[18px] text-brand-magenta" />
        </div>
        <div>
          <h3 className="text-base font-semibold heading">Connect a mobile device</h3>
          <p className="text-xs" style={{ color: 'var(--s-muted)' }}>Scan this in the Soteria mobile app to connect it to this environment</p>
        </div>
      </div>

      <div className="mt-4 flex flex-col sm:flex-row gap-5">
        {/* QR: always dark modules on white so it scans in any theme (the one place
            a fixed color is correct - a themed QR can fail to scan). */}
        <div className="shrink-0 self-center sm:self-start">
          <div className="rounded-xl p-3" style={{ backgroundColor: '#ffffff' }}>
            <QRCodeSVG value={json} size={168} level="M" marginSize={0} bgColor="#ffffff" fgColor="#111111" />
          </div>
        </div>

        <div className="min-w-0 flex-1 space-y-3">
          <p className="text-sm" style={{ color: 'var(--s-text)' }}>
            Open the Soteria app, choose <span className="font-medium">Scan QR code</span>, and point it here. The app reads this server's address, fetches its configuration from the server, and you sign in (with MFA) on the phone.
          </p>

          <div className="rounded-lg px-3 py-2 text-sm font-mono break-all" style={{ backgroundColor: 'var(--s-code-bg)', color: 'var(--s-text)', border: '1px solid var(--s-border)' }}>
            {payload.baseUrl}
          </div>

          <div className="flex flex-wrap gap-2">
            <button onClick={() => copy('url', payload.baseUrl)} className="btn-secondary text-xs flex items-center gap-1.5">
              {copied === 'url' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied === 'url' ? 'Copied' : 'Copy address'}
            </button>
            <button onClick={() => setShowDetails((v) => !v)} className="btn-secondary text-xs flex items-center gap-1.5">
              {showDetails ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              {showDetails ? 'Hide details' : 'Details'}
            </button>
          </div>

          {showDetails && (
            <div className="rounded-lg p-3 text-xs space-y-1.5" style={{ backgroundColor: 'var(--s-bg)', color: 'var(--s-muted)', border: '1px solid var(--s-border)' }}>
              <p><span style={{ color: 'var(--s-text)' }}>Manual entry:</span> in the app choose "Enter endpoint" and type the address above.</p>
              <p>The app then fetches <span className="font-mono">{payload.baseUrl}/connect-info.json</span> to learn how to reach the server. Rotate the Supabase anon key in one place and every device picks it up on next connect.</p>
              <button onClick={() => copy('payload', json)} className="underline hover:text-brand-pink transition-colors">
                {copied === 'payload' ? 'copied QR payload' : 'copy raw QR payload (JSON)'}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 flex items-start gap-2 px-3 py-2 rounded-lg text-xs" style={{ backgroundColor: 'var(--s-bg)', border: '1px solid var(--s-border)', color: 'var(--s-muted)' }}>
        <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        This code contains only this server's address. No key, no password, and no session are in it, so it is safe to display. The device fetches its configuration from the server and authenticates on its own.
      </div>
    </div>
  );
}
