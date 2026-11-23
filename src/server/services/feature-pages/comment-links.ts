import { dbRead } from '~/server/db/client';
import { FEATURE_PAGES_FEATURE_URN_PREFIX } from '~/shared/constants/feature-pages.constants';

/**
 * The civitai page a Feature Pages thread is shown on, for moderators: `/features/<slug>` when the
 * thread hangs on a feature. A request's thread is shown inside a feature the mirror does not know,
 * so it has no link.
 */
export async function featurePageCommentHref(topicId: number) {
  const topic = await dbRead.featurePageTopic.findUnique({
    where: { id: topicId },
    select: { urn: true },
  });
  if (!topic?.urn.startsWith(FEATURE_PAGES_FEATURE_URN_PREFIX)) return null;
  return `/features/${encodeURIComponent(
    topic.urn.slice(FEATURE_PAGES_FEATURE_URN_PREFIX.length)
  )}`;
}
