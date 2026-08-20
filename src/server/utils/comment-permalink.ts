import type { Prisma } from '@prisma/client';
import { threadUrlMap } from '~/server/notifications/comment.notifications';

/**
 * The thread-parent relations `/comments/v2/<id>` resolves against, and the ONE definition of
 * them — the page selects exactly this, and the resolver reads exactly this.
 *
 * 🔴 `satisfies Prisma.ThreadSelect` is NOT what closes the gap, and it is worth being precise
 * about why, because it looks like it should. Every field of a `*Select` type is OPTIONAL, so
 * OMISSION satisfies it: delete the `appListing` line and this still type-checks. What `satisfies`
 * buys is only that each key that IS present is a real relation with real fields — it catches
 * `appListings` (plural) and `slugg`, not a dropped entry. The omission half is closed by
 * `ThreadEntitySource` below.
 */
export const threadEntitySelect = {
  image: { select: { id: true } },
  post: { select: { id: true } },
  review: { select: { id: true } },
  model: { select: { id: true } },
  article: { select: { id: true } },
  bounty: { select: { id: true } },
  bountyEntry: { select: { id: true } },
  challenge: { select: { id: true } },
  comicChapter: { select: { projectId: true } },
  model3d: { select: { id: true } },
  appListing: { select: { slug: true } },
} satisfies Prisma.ThreadSelect;

/**
 * The full comment query the page runs. Lives here rather than in the page so the select and the
 * code that reads it cannot drift — they are one rule, and this is its one place.
 *
 * 🔴 `rootThread` MUST carry the entity relations too. It is how a REPLY reaches its entity page
 * (a reply's own thread is keyed by its parent comment and carries no entity), so narrowing this
 * to `{ id: true }` would break reply permalinks for EVERY entity type sitewide.
 */
export const commentPermalinkSelect = {
  id: true,
  thread: {
    select: {
      id: true,
      rootThread: { select: { id: true, ...threadEntitySelect } },
      comment: { select: { id: true } },
      ...threadEntitySelect,
    },
  },
} satisfies Prisma.CommentV2Select;

/** Exactly what `dbRead.commentV2.findUnique({ select: commentPermalinkSelect })` returns. */
export type CommentPermalinkPayload = Prisma.CommentV2GetPayload<{
  select: typeof commentPermalinkSelect;
}>;

export type PermalinkThread = CommentPermalinkPayload['thread'];

/**
 * 🔴 THE COMPILE-TIME GUARD, and the reason this type exists rather than a hand-written interface.
 *
 * `Pick<T, K>` requires every K to be a key of T. So if a relation is dropped from
 * `threadEntitySelect`, the generated payload loses that property and this `Pick` becomes a type
 * ERROR — the omission `satisfies` cannot see. And because `rootThread`'s payload must also be
 * assignable here, narrowing its select to `{ id: true }` fails too.
 *
 * That converts three defects from "runtime 404 with a green suite" into `pnpm typecheck`
 * failures:
 *   1. dropping `appListing` from the select
 *   2. selecting `.id` instead of `.slug` on it
 *   3. narrowing `rootThread`'s select — the sitewide reply-permalink break
 *
 * 🔴 A MOCKED `dbRead` CANNOT CLOSE ANY OF THESE. Hand-writing the mock's return shape means the
 * fake encodes the same belief as the code, so both are wrong together and the suite stays green.
 * The remedy for a select-correctness gap is a TYPE, not a test.
 */
export type ThreadEntitySource = Pick<
  PermalinkThread,
  | 'image'
  | 'post'
  | 'review'
  | 'model'
  | 'article'
  | 'bounty'
  | 'bountyEntry'
  | 'challenge'
  | 'comicChapter'
  | 'model3d'
  | 'appListing'
>;

/**
 * Resolution for `/comments/v2/<id>` — the "copy comment link" permalink.
 *
 * Extracted from the page so it can be tested without a DB or a Next request. The page keeps
 * only the parts that genuinely need both: load the comment, redirect or 404.
 *
 * 🔴 THE ASYMMETRY THIS EXISTS TO HANDLE. Every thread entity except one is ID-addressed: the
 * `Thread` row carries the parent's integer id and that id appears verbatim in the URL. App-store
 * listings are SLUG-addressed (`/apps/store-preview/<slug>`) while `Thread.appListingId` holds
 * `app_listings.serial_id`, an INTEGER surrogate that appears nowhere in the URL. So an
 * app-listing thread legitimately has NO usable `threadParentId`, and the page's original
 * `if (!threadType || !threadParentId) return notFound` rejected every one of them — a 404 on a
 * link the UI had just offered to copy.
 *
 * That is the same asymmetry the notification URLs hit; both now resolve through the one
 * `threadUrlMap`, whose `appListing` arm reads `details.appListingSlug` and shares
 * `getListingDetailHref` with the store cards. A route rename therefore moves the permalink, the
 * notification and the card together.
 */

export type CommentThreadTarget = {
  threadType: string;
  /** `null` for a slug-addressed entity, which has no id in its URL. */
  threadParentId: number | null;
  appListingSlug?: string | null;
};

/**
 * First matching entity relation on this thread, or `null` if it carries none.
 *
 * 🔴 First-match-wins, and the `appListing` arm is APPENDED rather than inserted. A `Thread`'s
 * entity FKs are mutually exclusive (each is `@unique` and exactly one is set), so ordering is
 * unobservable in practice — appending anyway means no pre-existing type's precedence can move,
 * which is the cheap way to keep a sitewide-permalink regression off the table.
 */
const getThreadEntity = (thread: ThreadEntitySource): CommentThreadTarget | null => {
  if (thread.post) return { threadType: 'post', threadParentId: thread.post.id };
  if (thread.review) return { threadType: 'review', threadParentId: thread.review.id };
  if (thread.model) return { threadType: 'model', threadParentId: thread.model.id };
  if (thread.article) return { threadType: 'article', threadParentId: thread.article.id };
  if (thread.bounty) return { threadType: 'bounty', threadParentId: thread.bounty.id };
  if (thread.bountyEntry)
    return { threadType: 'bountyEntry', threadParentId: thread.bountyEntry.id };
  if (thread.challenge) return { threadType: 'challenge', threadParentId: thread.challenge.id };
  if (thread.comicChapter)
    return { threadType: 'comicChapter', threadParentId: thread.comicChapter.projectId };
  if (thread.image) return { threadType: 'image', threadParentId: thread.image.id };
  // Appended, like `appListing` below, so no pre-existing type's precedence moves. `model3d` was
  // MISSING here while `threadUrlMap` has had a working `/3d-models/<id>` arm all along and the
  // notification SQL resolves it — so every 3D-model comment permalink 404'd. See the PR body:
  // the TS chain had `comicChapter` but not `model3d`, the SQL CASE had `model3d` but not
  // `comicChapter` — two copies of one rule, and the bug lived in the disagreement.
  if (thread.model3d) return { threadType: 'model3d', threadParentId: thread.model3d.id };
  if (thread.appListing)
    return {
      threadType: 'appListing',
      threadParentId: null,
      appListingSlug: thread.appListing.slug,
    };
  return null;
};

/**
 * The entity target for a thread, or `null` when it cannot be addressed.
 *
 * The addressability rule differs by how the entity is addressed, because the two failure modes
 * differ: a missing id renders `/posts/null`, a missing slug renders
 * `/apps/store-preview/undefined`. Both are 404s dressed as working links, so neither may pass.
 */
export const resolveThreadTarget = (
  thread: ThreadEntitySource | null | undefined
): CommentThreadTarget | null => {
  if (!thread) return null;
  const target = getThreadEntity(thread);
  if (!target) return null;
  if (target.threadType === 'appListing') return target.appListingSlug ? target : null;
  return target.threadParentId ? target : null;
};

/**
 * The permalink for a comment, or `null` if the thread cannot be addressed — in which case the
 * page 404s exactly as it did before.
 *
 * Falls back to the ROOT thread when the immediate thread carries no entity, which is how a reply
 * (whose own thread is keyed by its parent COMMENT, not by an entity) reaches its entity page.
 */
export const buildCommentPermalink = ({
  thread,
  commentId,
}: {
  thread: PermalinkThread | null | undefined;
  commentId: number;
}): string | null => {
  if (!thread) return null;

  const target = resolveThreadTarget(thread) ?? resolveThreadTarget(thread.rootThread);
  if (!target) return null;

  const url = threadUrlMap({
    threadType: target.threadType,
    threadParentId: target.threadParentId,
    appListingSlug: target.appListingSlug,
    threadId: thread.id,
    commentId,
    // Always pin the target comment as the thread root so it renders standalone via
    // RootThreadProvider's activeComment path. Sidesteps cursor-paginated thread fetches
    // (target may be on page N) and works uniformly for root and reply comments.
    commentParentType: 'comment',
    commentParentId: commentId,
  });

  return url ?? null;
};
