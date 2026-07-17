import { useEffect, useState, FormEvent } from 'react';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthProvider';
import Modal from './Modal';

export default function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (open) {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setError(null);
      setSuccess(false);
    }
  }, [open]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError('New passwords do not match.');
      return;
    }
    if (newPassword === currentPassword) {
      setError('New password must be different from the current one.');
      return;
    }

    setSaving(true);

    // GoTrue does not check the old password on update, so validate it
    // ourselves by re-authenticating first.
    const { error: reauthError } = await supabase.auth.signInWithPassword({
      email: user?.email ?? '',
      password: currentPassword,
    });
    if (reauthError) {
      setSaving(false);
      setError('Current password is incorrect.');
      return;
    }

    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
    setSaving(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setSuccess(true);
  };

  return (
    <Modal open={open} onClose={onClose} title="Change Password">
      {success ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-sm text-emerald-400">
            <CheckCircle2 className="w-4 h-4 shrink-0" /> Password updated successfully.
          </div>
          <div className="flex justify-end">
            <button onClick={onClose} className="btn-primary">Done</button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
              <AlertCircle className="w-4 h-4 shrink-0" /> {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Current Password</label>
            <input
              type="password" required autoComplete="current-password" value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="input-field" placeholder="••••••••••••"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>New Password</label>
            <input
              type="password" required minLength={8} autoComplete="new-password" value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="input-field" placeholder="Minimum 8 characters"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--s-text)' }}>Confirm New Password</label>
            <input
              type="password" required minLength={8} autoComplete="new-password" value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="input-field" placeholder="Repeat the new password"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
            <button type="submit" disabled={saving} className="btn-primary flex items-center gap-2">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              Update Password
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
