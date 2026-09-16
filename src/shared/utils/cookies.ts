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
   * ⚠️ `.optional()` HERE NO LONGER GATES A SECOND STORE, AND THE OLD NOTE SAID IT DID.
   * It used to read that `undefined` is "the ONLY signal that lets the client fall back to
   * `localStorage`". That fallback is DELETED — the cookie is now the rail's only store —
   * so an absent cookie and a cookie saying `'open'` mean the same thing to
   * `AppsRailProvider`, which defaults `undefined` to the open state.
   *
   * The history is kept because it is why the store went rather than got fixed: with
   * `.catch('open').default('open')` the schema could never return `undefined`, so the
   * discriminator never fired and the whole `localStorage` half was DEAD CODE in
   * production while three docstrings described it as a working fallback. Found by a
   * round-0 audit, not by a test. Making it reachable then reintroduced a reflow on every
   * hard load (round 2). Two rounds spent on a cohort — cookies cleared, storage survived
   * — who now re-collapse the rail once and are carried by the cookie thereafter.
   *
   * `.catch('open')` IS still load-bearing: a present-but-unparseable cookie must resolve
   * to `'open'` rather than to `undefined`, so a corrupted value fails open by declaration
   * rather than by accident. Pinned in `appsRailGeometry.test.ts`.
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
