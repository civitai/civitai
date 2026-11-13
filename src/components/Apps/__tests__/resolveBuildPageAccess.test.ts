import { describe, expect, it } from 'vitest';
import { resolveBuildPageAccess } from '~/components/Apps/resolveBuildPageAccess';

/**
 * The `/apps/build` SSR resolver. The BUILD decision is `canAccessAppsBuild` and is
 * exhaustively covered in `appsBuildAccess.test.ts`; the full viewer matrix, assistant included,
 * is `src/tests/pages/apps/build-page.test.ts`. What this file owns is the two things the resolver
 * adds on top — the SHAPE it returns, and that it never sends anyone to log in.
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

  it('returns notFound for a refused viewer', () => {
    expect(
      resolveBuildPageAccess({
        features: { appListings: true },
        user: { isModerator: false },
      })
    ).toEqual({ notFound: true });
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

  it('🔴 a logged-out viewer WITHOUT the flags gets notFound — not a redirect either', () => {
    const result = resolveBuildPageAccess({ features: { appListings: true }, user: null });
    expect(result).toEqual({ notFound: true });
  });

  it('never redirects a non-banned viewer anywhere, for ANY input in the flag space', () => {
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
