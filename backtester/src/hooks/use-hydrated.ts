'use client';

import { useEffect, useState } from 'react';

/**
 * True only after the first client render. Persisted state must not be read
 * during the server-matched paint or React reports a hydration mismatch.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}
