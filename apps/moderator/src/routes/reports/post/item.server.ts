import { getPostLookup, getRecentImagesOutsidePost } from '$lib/server/image-lookup.service';
import { loadAccountHistory } from '$lib/server/account-history';
import { loadItemReports } from '$lib/server/report-queue-load';
import { ReportEntity } from '$lib/reports';
import type { PostTab } from './tabs';

/**
 * The open post's half of the page: the post and its images, every open report about it, and its
 * owner's history (on its own tab). The queue is the layout's and does not rerun when the post changes. Shared by the
 * bare `/reports/post`, which opens the queue's first post, and `[postId]`.
 *
 * A post report names CONTENT, not an account, so the owner is found by reading the post — there is
 * no owner to look up until it has been read, hence the second round trip.
 */
export async function loadPostItem(postId: number, tab: PostTab, locals: App.Locals) {
  const [lookup, reports] = await Promise.all([
    getPostLookup(postId),
    loadItemReports(ReportEntity.Post, postId),
  ]);
  const ownerId = lookup?.post.userId ?? null;
  // The heavy read, on its own tab only: a moderator settling a report from the images never opens it.
  const [accountHistory, ownerRecentImages] = await Promise.all([
    ownerId && tab === 'owner' ? loadAccountHistory(ownerId, locals.user.username ?? null) : null,
    // Whether the post looks like the rest of the account's work is often the whole ruling, and at
    // queue volume nobody opens the profile to check.
    ownerId && tab === 'images' ? getRecentImagesOutsidePost(ownerId, postId) : [],
  ]);
  return { postId, tab, lookup, reports, ownerId, accountHistory, ownerRecentImages };
}

export type PostItem = Awaited<ReturnType<typeof loadPostItem>>;
