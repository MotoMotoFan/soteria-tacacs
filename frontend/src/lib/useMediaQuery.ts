import { useEffect, useState } from 'react';

/**
 * Subscribes to a CSS media query and returns whether it currently matches.
 * Used to drive layout that can't be expressed in pure Tailwind responsive
 * classes (e.g. the sidebar being an in-flow rail on desktop but an off-canvas
 * drawer on mobile). SSR-safe: defaults to false until mounted.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** Tailwind's `lg` breakpoint (1024px). True on desktop-width viewports. */
export function useIsDesktop(): boolean {
  return useMediaQuery('(min-width: 1024px)');
}
