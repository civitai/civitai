import { ReactNode } from 'react';
import useIsClient from '~/hooks/useIsClient';

export function IsHydrated({ children }: { children: ReactNode }) {
  const isClient = useIsClient();
  if (!isClient) return null;
  return <>{children}</>;
}
