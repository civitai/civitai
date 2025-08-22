import { getCookies } from 'cookies-next';
import { useSession } from 'next-auth/react';

import React, { createContext, useContext, useMemo } from 'react';
import { useIsClient } from '~/providers/IsClientProvider';
import type { ParsedCookies } from '~/shared/utils/cookies';
import { parseCookies } from '~/shared/utils/cookies';

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
  const { status } = useSession();
  const isAuthed = status === 'authenticated';
  const isClient = useIsClient();
  const cookies = useMemo(() => {
    if (!isClient) return initialValue;
    else return parseCookies(getCookies());
  }, [isAuthed]);

  return <CookiesCtx.Provider value={cookies}>{children}</CookiesCtx.Provider>;
};
