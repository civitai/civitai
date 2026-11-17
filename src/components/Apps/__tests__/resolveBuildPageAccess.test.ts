import { describe, expect, it } from 'vitest';
import { resolveBuildPageAccess } from '~/components/Apps/resolveBuildPageAccess';

/**
 * The `/apps/build` SSR resolver. The BUILD decision is `canAccessAppsBuild` and is
 * exhaustively covered in `appsBuildAccess.test.ts`; the full viewer matrix, assistant included,
 * is `src/tests/pages/apps/build-page.test.ts`. What this file owns is what the resolver adds on
 * top — the SHAPE it returns, what a REFUSED viewer gets instead (the request view when signed in,
 * sign-in when signed out with `?request-access=1`), and that it sends nobody else to log in.
 */
describe('resolveBuildPageAccess', () => {
  it('returns the build view for an admitted viewer', () => {
    expect(
      resolveBuildPageAccess({
        features: { appListings: true, appBlocksGetStarted: true },
        user: { isModerator: false },
      })
    ).toEqual({ props: { mode: 'build' } });
  });

  it('🔴 a refused SIGNED-IN viewer gets the request view, not notFound', () => {
    // The people the gate refuses are exactly the people the Request access form is for.
    expect(
      resolveBuildPageAccess({
        features: { appListings: true },
        user: { isModerator: false },
      })
    ).toEqual({ props: { mode: 'request' } });
    // No flags at all — an ordinary account.
    expect(resolveBuildPageAccess({ features: {}, user: { isModerator: false } })).toEqual({
      props: { mode: 'request' },
    });
  });

  it('a refused BANNED viewer still gets notFound', () => {
    expect(
      resolveBuildPageAccess({
        features: {},
        user: { isModerator: false, bannedAt: new Date('2026-09-01T00:00:00Z') },
      })
    ).toEqual({ notFound: true });
  });

  it('🔴 a refused signed-out viewer WITH ?request-access=1 is sent to sign in and back', () => {
    expect(
      resolveBuildPageAccess({
        features: {},
        user: null,
        wantsRequestAccess: true,
        returnUrl: '/apps/build?request-access=1',
      })
    ).toEqual({
      redirect: {
        destination: '/login?returnUrl=%2Fapps%2Fbuild%3Frequest-access%3D1&reason=perform-action',
        permanent: false,
      },
    });
  });

  it('an ADMITTED signed-out viewer with the param stays on the pitch — no sign-in wall', () => {
    expect(
      resolveBuildPageAccess({
        features: { appListings: true, appBlocksGetStarted: true },
        user: null,
        wantsRequestAccess: true,
        returnUrl: '/apps/build?request-access=1',
      })
    ).toEqual({ props: { mode: 'build' } });
  });

  it('fails CLOSED with no features at all', () => {
    expect(resolveBuildPageAccess({})).toEqual({ notFound: true });
    expect(resolveBuildPageAccess({ features: null, user: null })).toEqual({ notFound: true });
  });

  it('hands a signed-in assistant viewer to the assistant view', () => {
    expect(
      resolveBuildPageAccess({
        features: { appBlocks: true, appAssistant: true },
        user: { isModerator: false },
      })
    ).toEqual({ assistant: true });
  });

  /**
   * 🔴 THE BUILD STATES ARE A HARD `notFound`, NEVER A LOGIN REDIRECT. State A (the pitch) needs
   * no user, and a login wall in front of a recruiting page defeats the funnel. The pages this
   * replaced had login redirects, so copying their resolver is the likely edit.
   */
  it('🔴 a logged-out viewer with the build flags is ADMITTED, not redirected to login', () => {
    const result = resolveBuildPageAccess({
      features: { appListings: true, appBlocksGetStarted: true },
      user: null,
    });
    expect(result).toEqual({ props: { mode: 'build' } });
  });

  it('🔴 a logged-out viewer WITHOUT the flags (and no param) gets notFound — not a redirect', () => {
    const result = resolveBuildPageAccess({ features: { appListings: true }, user: null });
    expect(result).toEqual({ notFound: true });
  });

  it('without the param, never redirects a non-banned viewer, for ANY input in the flag space', () => {
    for (const appListings of [false, true])
      for (const appBlocks of [false, true])
        for (const appBlocksAuthor of [false, true])
          for (const appBlocksGetStarted of [false, true])
            for (const appAssistant of [false, true])
              for (const user of [null, { isModerator: false }, { isModerator: true }]) {
                expect(
                  resolveBuildPageAccess({
                    features: {
                      appListings,
                      appBlocks,
                      appBlocksAuthor,
                      appBlocksGetStarted,
                      appAssistant,
                    },
                    user,
                  })
                ).not.toHaveProperty('redirect');
              }
  });
});
