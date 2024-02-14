import { getCookies } from 'cookies-next';
import { TmpCookiesObj } from 'cookies-next/lib/types';

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsClient } from '~/providers/IsClientProvider';

const CookiesCtx = createContext<CookiesContext | null>(null);
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
    if (!isClient) return handleParseCookies(initialValue);
    else {
      const cookies = parseCookies(getCookies());
      const zodCookies = handleParseCookies(cookies);
      return zodCookies;
    }
  }, [isClient, currentUser]);
  // const [cookies, setCookies] = useState(handleParseCookies(initialValue));
  // console.log({ initialValue });

  // useEffect(() => {
  //   const cookies = parseCookies(getCookies());
  //   const zodCookies = handleParseCookies(cookies);
  //   console.log('zodCookies', zodCookies);
  //   setCookies(zodCookies);
  // }, [currentUser]);

  return <CookiesCtx.Provider value={cookies}>{children}</CookiesCtx.Provider>;
};

const handleParseCookies = (data: Record<string, unknown>) => {
  const result = cookiesSchema.safeParse(data);
  if (result.success) return result.data;
  return cookiesSchema.parse({});
};

const cookiesSchema = z.object({
  showNsfw: z.coerce.boolean().optional(),
  blurNsfw: z.coerce.boolean().optional(),
  browsingLevel: z.coerce.number().optional(),
  referrals: z
    .object({
      code: z.string().optional(),
      source: z.string().optional(),
      landingPage: z.string().optional(),
      loginRedirectReason: z.string().optional(),
    })
    .default({}),
});
export type CookiesContext = z.infer<typeof cookiesSchema>;

export type ParsedCookies = ReturnType<typeof parseCookies>;
export function parseCookies(cookies: TmpCookiesObj) {
  return {
    showNsfw: cookies?.['nsfw'],
    blurNsfw: cookies?.['blur'],
    browsingLevel: cookies?.['level'],
    referrals: {
      code: cookies?.['ref_code'],
      source: cookies?.['ref_source'],
      landingPage: cookies?.['ref_landing_page'],
      loginRedirectReason: cookies?.['ref_login_redirect_reason'],
    },
  };
}
