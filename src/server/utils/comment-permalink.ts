import { threadUrlMap } from '~/server/notifications/comment.notifications';

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
const getThreadEntity = (thread: any): CommentThreadTarget | null => {
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
export const resolveThreadTarget = (thread: any): CommentThreadTarget | null => {
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
  thread: any;
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
