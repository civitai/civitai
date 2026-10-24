import { describe, expect, it } from 'vitest';
import { resolveBuildPageAccess } from '~/components/Apps/resolveBuildPageAccess';

/**
 * The `/apps/build` SSR resolver. The DECISION is `canAccessAppsBuild` and is
 * exhaustively covered in `appsBuildAccess.test.ts`; what this file owns is the two
 * things the resolver adds on top of it — the SHAPE it returns, and the fact that it does
 * NOT redirect.
 */
describe('resolveBuildPageAccess', () => {
  it('returns props for an admitted viewer', () => {
    expect(
      resolveBuildPageAccess({
        features: { appListings: true, appBlocksGetStarted: true },
        user: { isModerator: false },
      })
    ).toEqual({ props: {} });
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

  /**
   * 🔴 A HARD `notFound`, NEVER A LOGIN REDIRECT — the one place this resolver
   * deliberately differs from `/apps/mine` and `/apps/submit`, both of which bounce a
   * session-less request to `/login`.
   *
   * State A (the pitch) is the DEFAULT state and needs no user: the `appBlocksGetStarted`
   * term of the predicate consults only a flag. A login wall in front of a recruiting
   * page defeats the funnel. Asserted rather than described, because "it currently
   * doesn't redirect" is indistinguishable from "nobody has added one yet", and the two
   * pages this replaced BOTH have one — so copying their resolver is the likely edit.
   */
  it('🔴 a logged-out viewer with the flags is ADMITTED, not redirected to login', () => {
    const result = resolveBuildPageAccess({
      features: { appListings: true, appBlocksGetStarted: true },
      user: null,
    });
    expect(result).toEqual({ props: {} });
    expect(result).not.toHaveProperty('redirect');
  });

  it('🔴 a logged-out viewer WITHOUT the flags gets notFound — not a redirect either', () => {
    // The discriminating control for the case above. Both anon branches must be
    // redirect-free; asserting only the admitted one would pass for a resolver that
    // redirects exactly the viewers it refuses.
    const result = resolveBuildPageAccess({ features: { appListings: true }, user: null });
    expect(result).toEqual({ notFound: true });
    expect(result).not.toHaveProperty('redirect');
  });

  it('never returns a redirect for ANY input in the flag space', () => {
    for (const appListings of [false, true])
      for (const appBlocksAuthor of [false, true])
        for (const appBlocksGetStarted of [false, true])
          for (const user of [null, { isModerator: false }, { isModerator: true }]) {
            expect(
              resolveBuildPageAccess({
                features: { appListings, appBlocksAuthor, appBlocksGetStarted },
                user,
              })
            ).not.toHaveProperty('redirect');
          }
  });
});
