import { describe, expect, it } from 'vitest';
import { canAccessAppsActivity } from '~/shared/utils/app-blocks-access';
import { resolveActivityPageAccess } from '~/components/Apps/resolveActivityPageAccess';

/**
 * 🔒 THE `/apps/activity` SSR GATE.
 *
 * 🔴 THE ASSERTION WITH A MEASURED RED ON PRE-CHANGE CODE is
 * `a viewer holding appBlocksPages but NOT appBlocks is admitted`. The page's gate at
 * `origin/main` (then `pages/apps/installed.tsx`) read
 *
 *     if (!features?.appBlocks) return { notFound: true };
 *
 * so that viewer got `notFound`. That is the dishonest half of calling the page
 * "Activity": `appBlocks` is the model-SLOT flag, while `/apps/run/<slug>` — the
 * full-page app runtime — is gated on `appBlocksPages`. Someone who has only ever run a
 * full-page app has generations, scope-gated API calls and Buzz spends recorded against
 * them, and not one slot install.
 *
 * The rest of this file is new-feature coverage for a new module, and is labelled as
 * such rather than counted as regression coverage.
 */

const LOGIN = '/login?returnUrl=%2Fapps%2Factivity';
const USER = { id: 7 };

describe('resolveActivityPageAccess', () => {
  it('🔴 admits a viewer holding appBlocksPages but NOT appBlocks (RED at origin/main)', () => {
    expect(
      resolveActivityPageAccess({
        features: { appBlocks: false, appBlocksPages: true },
        user: USER,
        loginDestination: LOGIN,
      })
    ).toEqual({ props: {} });
  });

  it('admits a viewer holding appBlocks but NOT appBlocksPages (the pre-change cohort)', () => {
    expect(
      resolveActivityPageAccess({
        features: { appBlocks: true, appBlocksPages: false },
        user: USER,
        loginDestination: LOGIN,
      })
    ).toEqual({ props: {} });
  });

  it('🔴 NEGATIVE CONTROL: a viewer with NEITHER runtime flag gets notFound', () => {
    // Without this, every "admits" assertion above could be satisfied by a resolver that
    // returns `props` unconditionally.
    expect(
      resolveActivityPageAccess({
        features: { appBlocks: false, appBlocksPages: false },
        user: USER,
        loginDestination: LOGIN,
      })
    ).toEqual({ notFound: true });
  });

  it('fails CLOSED on absent / null / empty features', () => {
    for (const features of [undefined, null, {}] as const) {
      expect(resolveActivityPageAccess({ features, user: USER, loginDestination: LOGIN })).toEqual({
        notFound: true,
      });
    }
  });

  it('🔒 the FLAG gate runs BEFORE the session check', () => {
    // Order is the disclosure property: an ungated visitor must learn nothing from the
    // response, not even that the route exists. If the session check ran first, a
    // signed-out ungated visitor would get a login redirect naming the route.
    expect(
      resolveActivityPageAccess({ features: {}, user: null, loginDestination: LOGIN })
    ).toEqual({ notFound: true });
  });

  it('redirects a signed-out but GATED viewer to login rather than 404ing them', () => {
    expect(
      resolveActivityPageAccess({
        features: { appBlocksPages: true },
        user: null,
        loginDestination: LOGIN,
      })
    ).toEqual({ redirect: { destination: LOGIN, permanent: false } });
  });

  it('positive control: the shared predicate really does refuse someone, on EACH term', () => {
    // Guards the cases above against the predicate having collapsed to a constant, and
    // does it per-term so a gate that ignored one input still reds here.
    expect(canAccessAppsActivity({ appBlocks: true, appBlocksPages: false })).toBe(true);
    expect(canAccessAppsActivity({ appBlocks: false, appBlocksPages: true })).toBe(true);
    expect(canAccessAppsActivity({ appBlocks: false, appBlocksPages: false })).toBe(false);
    expect(canAccessAppsActivity(null)).toBe(false);
  });
});
