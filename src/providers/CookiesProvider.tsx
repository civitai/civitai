import { TmpCookiesObj } from 'cookies-next/lib/types';

import React, { createContext, useContext, useState } from 'react';
import { z } from 'zod';

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
  const [value] = useState(() => {
    const result = cookiesSchema.safeParse(initialValue);
    if (result.success) return result.data;
    return cookiesSchema.parse({});
  });

  return <CookiesCtx.Provider value={value}>{children}</CookiesCtx.Provider>;
};

const cookiesSchema = z.object({
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
    browsingLevel: cookies?.['level'],
    referrals: {
      code: cookies?.['ref_code'],
      source: cookies?.['ref_source'],
      landingPage: cookies?.['ref_landing_page'],
      loginRedirectReason: cookies?.['ref_login_redirect_reason'],
    },
  };
}
