import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import Modal from './Modal';

// MFA is mandatory and enrolled during login; users cannot disable it themselves,
// so this modal is status-only. Resets are done by an administrator (Settings →
// Web UI Users, or the soteria-mfa CLI on the server).
export default function TwoFactorModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [enrolledAt, setEnrolledAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    supabase.auth.mfa.listFactors().then(({ data, error: listError }) => {
      if (listError) setError(listError.message);
      else {
        const verified = data.totp.find((f) => f.status === 'verified');
        setEnrolledAt(verified?.created_at ?? null);
      }
      setLoading(false);
    });
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title="Two-Factor Authentication">
      {error && (
        <div className="flex items-center gap-2 px-3 py-2.5 mb-4 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="w-6 h-6 animate-spin text-brand-magenta" />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-sm text-emerald-400">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            Two-factor authentication is active on this account
            {enrolledAt && <> (enrolled {new Date(enrolledAt).toLocaleDateString()})</>}.
          </div>
          <div className="flex items-start gap-2 text-xs" style={{ color: 'var(--s-muted)' }}>
            <ShieldCheck className="w-4 h-4 shrink-0 text-brand-magenta" />
            <p>
              MFA is required for all accounts and cannot be disabled here. If you lost
              access to your authenticator app, ask an administrator to reset it
              (Settings → Web UI Users → Reset MFA). You will be asked to enroll a new
              authenticator at your next sign-in.
            </p>
          </div>
          <div className="flex justify-end">
            <button onClick={onClose} className="btn-primary">Close</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
