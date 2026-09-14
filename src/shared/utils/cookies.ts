import type { TmpCookiesObj } from 'cookies-next/lib/types';
import * as z from 'zod';
import { booleanString } from '~/utils/zod-helpers';

/**
 * The `/apps/*` rail's cookie name.
 *
 * 🔴 DECLARED HERE, NOT IN `~/components/Apps/appsRailState`, AND THE DIRECTION IS THE
 * REASON. This module is parsed on the SERVER (in `_app`'s `getInitialProps`) and is a
 * dependency-free shared util; the rail module is a React `.tsx`. Importing upward from
 * here would drag React into the server-side cookie parse. So the name lives at the
 * bottom of the graph and the rail imports it, which also keeps the writer (the toggle)
 * and this reader on ONE spelling rather than two literals that can drift.
 */
export const APPS_RAIL_COOKIE = 'apps-rail';

const cookiesSchema = z.object({
  // showNsfw: booleanString().optional(),
  // blurNsfw: booleanString().optional(),
  // browsingLevel: z.coerce.number().optional(),
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
  consent: z.enum(['accepted', 'rejected']).nullable().catch(null).default(null),
  /**
   * The `/apps/*` left rail's collapse state — the SSR seed for
   * `~/components/Apps/appsRailState`.
   *
   * 🔴 A COOKIE RATHER THAN `localStorage` ALONE BECAUSE THE SERVER HAS TO KNOW. Every
   * `/apps/*` page is server-rendered, `localStorage` does not exist there, and a rail
   * the server always renders OPEN means a viewer who collapsed it gets a 260 → 56 jump
   * on hydration — which re-ladders the container-queried store grid underneath, so the
   * whole page reflows rather than just the nav. `localStorage` is still written (it is
   * the client-side store); this is what makes the first paint right.
   *
   * `.catch('open')` and the closed enum together mean an unknown or truncated value can
   * only ever fail OPEN — a visible navigation — never hidden.
   *
   * 🔴 `.optional()` AND NOT `.default('open')`, AND THE DIFFERENCE IS A WHOLE FEATURE.
   * `undefined` here means "this request carried no rail cookie", which is the ONLY signal
   * that lets the client fall back to `localStorage`. A `.default('open')` collapses that
   * case into an indistinguishable `'open'`, so `AppsRailProvider` always receives a real
   * seed, `useAppsRail`'s `seed !== null` short-circuit fires on every render, and
   * `readAppsRailStorage()` NEVER EXECUTES IN PRODUCTION — the `localStorage` half becomes
   * write-only while three docstrings go on describing it as a working fallback. That is
   * exactly how it shipped in the first draft of this change, and nothing caught it: the
   * only test exercising the adoption branch reaches it through the provider-less path,
   * which `_app` never takes. Found by an adversarial round-0 audit, not by a test.
   *
   * The cohort it is for is real and not rare: a viewer whose cookies are cleared (privacy
   * tooling, a 1-year expiry, a browser "clear cookies but keep site data" setting) while
   * `localStorage` survives. With the discriminator intact they keep their collapsed rail
   * after one post-mount adoption; without it they silently get the default back.
   */
  appsRail: z.enum(['open', 'collapsed']).optional().catch('open'),
});

function parseCookiesObj(cookies: TmpCookiesObj) {
  return {
    // showNsfw: cookies?.['nsfw'],
    // blurNsfw: cookies?.['blur'],
    // browsingLevel: cookies?.['level'],
    disableHidden: cookies?.['disableHidden'],
    mode: cookies?.['mode'],
    referrals: {
      code: cookies?.['ref_code'],
      source: cookies?.['ref_source'],
      landingPage: cookies?.['ref_landing_page'],
      loginRedirectReason: cookies?.['ref_login_redirect_reason'],
    },
    consent: cookies?.['civitai-consent'],
    // Key single-sourced from the module that owns the rail, so the writer (the toggle)
    // and this reader cannot drift to two spellings.
    appsRail: cookies?.[APPS_RAIL_COOKIE],
  };
}

export type ParsedCookies = ReturnType<typeof parseCookies>;
export function parseCookies(cookies: TmpCookiesObj) {
  const parsed = parseCookiesObj(cookies);
  const result = cookiesSchema.safeParse(parsed);
  if (result.success) return result.data;
  return cookiesSchema.parse({});
}
