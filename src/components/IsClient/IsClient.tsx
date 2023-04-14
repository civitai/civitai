import { ReactNode } from 'react';
import useIsClient from '~/hooks/useIsClient';

export function IsClient({ children }: { children: ReactNode }) {
  const isClient = useIsClient();
  return isClient ? <>{children}</> : null;
}
