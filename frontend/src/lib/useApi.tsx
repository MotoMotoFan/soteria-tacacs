import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Fetch-on-mount hook for agent API data with reload support.
 * `fetcher` must be referentially stable or wrapped by the caller -
 * pass `deps` for anything it closes over (e.g. a date filter).
 */
export function useApi<T>(fetcher: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetcherRef.current());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void reload();
    // Commit/discard of the staging session invalidates page data.
    const handler = () => void reload();
    window.addEventListener('soteria:entities-changed', handler);
    return () => window.removeEventListener('soteria:entities-changed', handler);
  }, [reload]);

  return { data, loading, error, reload };
}

/** Standard inline banner content for load errors. */
export function LoadState({ loading, error, onRetry, children }: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  children?: React.ReactNode;
}) {
  if (loading) {
    return (
      <div className="glass-card py-12 text-center" style={{ color: 'var(--s-muted)' }}>
        Loading…
      </div>
    );
  }
  if (error) {
    return (
      <div className="glass-card py-8 px-6 text-center space-y-3">
        <p className="text-sm text-red-400">{error}</p>
        <button onClick={onRetry} className="btn-secondary text-sm">Retry</button>
      </div>
    );
  }
  return <>{children}</>;
}
