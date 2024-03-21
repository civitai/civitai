import { TmpCookiesObj } from 'cookies-next/lib/types';
import { z } from 'zod';
import { booleanString } from '~/utils/zod-helpers';

const cookiesSchema = z.object({
  showNsfw: booleanString().optional(),
  blurNsfw: booleanString().optional(),
  browsingLevel: z.coerce.number().optional(),
  disableHidden: booleanString().optional(),
  mode: z.enum(['SFW', 'NSFW', 'All']).optional(),
  referrals: z
    .object({
      code: z.string().optional(),
      source: z.string().optional(),
      landingPage: z.string().optional(),
      loginRedirectReason: z.string().optional(),
    })
    .default({}),
});

function parseCookiesObj(cookies: TmpCookiesObj) {
  return {
    showNsfw: cookies?.['nsfw'],
    blurNsfw: cookies?.['blur'],
    browsingLevel: cookies?.['level'],
    disableHidden: cookies?.['disableHidden'],
    mode: cookies?.['mode'],
    referrals: {
      code: cookies?.['ref_code'],
      source: cookies?.['ref_source'],
      landingPage: cookies?.['ref_landing_page'],
      loginRedirectReason: cookies?.['ref_login_redirect_reason'],
    },
  };
}

export type ParsedCookies = ReturnType<typeof parseCookies>;
export function parseCookies(cookies: TmpCookiesObj) {
  const parsed = parseCookiesObj(cookies);
  const result = cookiesSchema.safeParse(parsed);
  if (result.success) return result.data;
  return cookiesSchema.parse({});
}
