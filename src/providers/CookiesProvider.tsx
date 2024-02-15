import { getCookies } from 'cookies-next';

import React, { createContext, useContext, useMemo } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsClient } from '~/providers/IsClientProvider';
import { ParsedCookies, parseCookies } from '~/shared/utils';

const CookiesCtx = createContext<ParsedCookies | null>(null);
export const useCookies = () => {
  const context = useContext(CookiesCtx);
  if (!context) throw new Error('Missing CookiesCtx.Provider in the tree');
  return context;
};
export const CookiesProvider = ({
  children,
  value: initialValue,
}: {
  children: React.ReactNode;
  value: ParsedCookies;
}) => {
  const currentUser = useCurrentUser();
  const isClient = useIsClient();
  const cookies = useMemo(() => {
    if (!isClient) return initialValue;
    else return parseCookies(getCookies());
  }, [isClient, currentUser]);

  return <CookiesCtx.Provider value={cookies}>{children}</CookiesCtx.Provider>;
};
