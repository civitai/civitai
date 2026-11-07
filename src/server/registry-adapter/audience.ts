/**
 * Who a subscription streams to, as far as content ratings go: the mature ratings (`r`, `x`) its
 * principal may read. A registry policy never reads `meta`, so the origin narrows each stream that
 * carries an app's content per token: an app entity, its release entities, and its shared
 * documents (which carry no rating of their own: "a document's rating is its app's") reach a
 * subscription only when the app's rating is one that subscription's audience admits
 * ({@link audienceAdmits}, the one predicate both the document feed and the catalog use).
 *
 * The rule is the site's own, reused rather than re-derived:
 *   - the viewer's browsing level is `getServerBrowsingLevel` with mature content allowed: the
 *     saved level when the user has mature content on, else PG; anonymous is PG;
 *   - which ratings that level admits is `matureRatingsAllowed` / `matureRatingAllowed`, the
 *     public `/apps` catalog's gate on a mature-capable host: `r` with R in the level, `x` with X,
 *     and G / PG / PG-13 for everyone (the site never hides those by level).
 *
 * The registry is treated as a mature-capable surface, so the user's own settings are what narrow
 * a stream.
 */
import { getServerBrowsingLevel } from '~/server/utils/browsing-level';
import type { MatureRatingsAllowed } from '~/server/services/blocks/app-listing-store-gate';
import {
  matureRatingAllowed,
  matureRatingsAllowed,
} from '~/server/services/blocks/app-listing-store-gate';

export type Audience = {
  /**
   * The audience as a short stable string, which a document stream's stored state carries, so a
   * cursor issued to one audience is refused to another.
   */
  key: string;
  allowed: MatureRatingsAllowed;
};

const audienceOf = (allowed: MatureRatingsAllowed): Audience => ({
  key: `m${allowed.r ? 'r' : ''}${allowed.x ? 'x' : ''}`,
  allowed,
});

/** No token: what anyone may read (browsing level PG, so no mature rating). */
export const ANONYMOUS_AUDIENCE: Audience = audienceOf(
  matureRatingsAllowed(true, getServerBrowsingLevel({ canViewNsfw: true, user: null }))
);

/** The audience of a signed-in user, from their saved browsing settings. */
export function audienceForUser(user: {
  showNsfw?: boolean | null;
  browsingLevel?: number | null;
}): Audience {
  return audienceOf(
    matureRatingsAllowed(true, getServerBrowsingLevel({ canViewNsfw: true, user }))
  );
}

/**
 * Whether an app rated `rating`, and so its releases and its documents, may reach `audience`. A
 * null or unknown rating is not a mature one, so every audience is admitted it
 * ({@link matureRatingAllowed}).
 */
export const audienceAdmits = (audience: Audience, rating: string | null | undefined) =>
  matureRatingAllowed(rating, audience.allowed);

/** A subscription's audience, from its adapter context: absent is anonymous, the narrowest. */
export const contextAudience = (ctx?: { audience?: Audience }): Audience =>
  ctx?.audience ?? ANONYMOUS_AUDIENCE;
