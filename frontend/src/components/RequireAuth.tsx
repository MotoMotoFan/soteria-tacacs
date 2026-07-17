import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from './AuthProvider';

export default function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading, mfaPending, mfaEnrollRequired } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: 'var(--s-bg)' }}>
        <Loader2 className="w-8 h-8 animate-spin text-brand-magenta" />
      </div>
    );
  }

  if (!session || mfaPending || mfaEnrollRequired) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  return <>{children}</>;
}
