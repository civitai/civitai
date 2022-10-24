import { useHasHydrated } from '../../hooks/useHasHydrated';
import { ReactNode } from 'react';

export function IsHydrated({ children }: { children: ReactNode }) {
  const isHydrated = useHasHydrated();
  if (!isHydrated) return null;
  return <>{children}</>;
}
