/**
 * Who a subscription streams to, as far as content ratings go: the mature ratings (`r`, `x`) its
 * principal may read. This is the one description of how this source narrows streams by rating;
 * `cursor.ts`, `entities.ts` and `doc-feed.ts` point here and describe only their own mechanics.
 *
 * A registry policy never reads `meta`, so the origin narrows each stream that carries an app's
 * content per token. Those streams are the app, release and schema streams (`RATED_SCHEMAS` in
 * `entities.ts`; the schema stream holds each app's collection schemas) and every shared-document
 * stream (`doc-feed.ts`). Each of their entities belongs to one app, and carries that app's
 * rating: a document has no rating of its own ("a document's rating is its app's"). It reaches a
 * subscription only when {@link audienceAdmits} admits the app's rating for that subscription's
 * audience, the one predicate the catalog and the document feed both use, so a subscription is
 * sent an app's entities exactly when it is sent its documents. The `service` stream belongs to
 * no app and is the same for every audience.
 *
 * Narrowing per audience means, for each of those streams:
 *   - a re-rating moves an app's entities out of an audience's stream (deletes) or into it
 *     (upserts);
 *   - a stored state, and so a cursor, records the audience it was served to: the same entities
 *     served to two audiences name two cursors, and a cursor issued to one audience is
 *     `cursor_expired` for another, refused before anything in its state is read;
 *   - stored states, their retention (`STATES_KEPT_PER_STREAM`) and the document feed's progress
 *     clock are kept per audience, so one audience's churn never evicts or delays another's.
 *
 * The rule is the site's own, reused rather than re-derived:
 *   - the viewer's browsing level is `getServerBrowsingLevel` with mature content allowed: the
 *     saved level when the user has mature content on, else PG; anonymous is PG;
 *   - which ratings that level admits is `matureRatingsAllowed` / `matureRatingAllowed`, the
 *     public `/apps` catalog's gate on a mature-capable host: `r` with R in the level, `x` with X,
 *     and G / PG / PG-13 for everyone (the site never hides those by level).
 * One difference: this source fails closed on a rating it does not know ({@link audienceAdmits}).
 *
 * The registry is treated as a mature-capable surface, so the user's own settings are what narrow
 * a stream, except in a region the site restricts to SFW content. The site sends such a request
 * to its SFW domain, where `canViewNsfw` is off and no host is mature-capable; this source has no
 * other domain, so it applies that domain's rule to the request instead: no mature rating,
 * whatever the user's settings ({@link audienceForUser}, `request-origin.ts`). Anonymous is
 * already that narrow.
 */
import { getServerBrowsingLevel } from '~/server/utils/browsing-level';
import type { MatureRatingsAllowed } from '~/server/services/blocks/app-listing-store-gate';
import {
  matureRatingAllowed,
  matureRatingsAllowed,
} from '~/server/services/blocks/app-listing-store-gate';
import { isOffsiteContentRating } from '~/shared/constants/browsingLevel.constants';

export type Audience = {
  /**
   * The audience as a short stable string, which a stream's stored state carries, so a cursor
   * issued to one audience is refused to another.
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

/**
 * The audience of a signed-in user, from their saved browsing settings. From a region the site
 * restricts to SFW content (`regionRestricted`), the SFW domain's rule: no mature rating.
 */
export function audienceForUser(
  user: {
    showNsfw?: boolean | null;
    browsingLevel?: number | null;
  },
  { regionRestricted = false }: { regionRestricted?: boolean } = {}
): Audience {
  const matureCapable = !regionRestricted;
  return audienceOf(
    matureRatingsAllowed(
      matureCapable,
      getServerBrowsingLevel({ canViewNsfw: matureCapable, user })
    )
  );
}

/**
 * Whether an app rated `rating`, and so its releases, collection schemas and documents, may reach
 * `audience`. A known rating (`g`, `pg`, `pg13`, `r`, `x`, any case) follows the site's rule
 * ({@link matureRatingAllowed}). A null, empty or unknown rating fails closed: it could be a
 * mature one, so it is admitted only to an audience that may read every mature rating (R and X).
 * Anonymous, and a user whose level leaves out R or X, is never sent it.
 *
 * The site's own predicate admits an unknown rating to everyone (it reads it as not mature); this
 * source is stricter because a stream leaves the site's surfaces, and its gate is not shared with
 * the store's SQL twin, so the two need not agree on a rating nothing should carry.
 */
export const audienceAdmits = (audience: Audience, rating: string | null | undefined): boolean =>
  isKnownRating(rating)
    ? matureRatingAllowed(rating, audience.allowed)
    : audience.allowed.r && audience.allowed.x;

/**
 * A content rating this source knows: `g`, `pg`, `pg13`, `r` or `x`, in any case. The one test
 * of it, shared by {@link audienceAdmits} and `appContentRating` (`entities.ts`).
 */
export const isKnownRating = (rating: string | null | undefined): rating is string =>
  typeof rating === 'string' && isOffsiteContentRating(rating.toLowerCase());

/** A subscription's audience, from its adapter context: absent is anonymous, the narrowest. */
export const contextAudience = (ctx?: { audience?: Audience }): Audience =>
  ctx?.audience ?? ANONYMOUS_AUDIENCE;
