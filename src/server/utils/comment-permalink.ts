import { kyselyRead } from '~/server/db/kyselyDb';
import { threadUrlMap } from '~/server/notifications/comment.notifications';

/**
 * What `/comments/<id>` reads: the comment's entity, plus the two addresses that are not the
 * entity id. A comic chapter is addressed by its project, and an app listing by its slug
 * (`entityId` is `app_listings.serial_id`, an integer that appears nowhere in the URL). A deleted
 * comment has no permalink: a placeholder in a section is reached through its replies.
 */
export const getCommentPermalinkRow = (commentId: number) =>
  kyselyRead
    .selectFrom('CommentV3 as c')
    .leftJoin('ComicChapter as cch', (join) =>
      join.onRef('cch.id', '=', 'c.entityId').on('c.entityType', '=', 'comicChapter')
    )
    .leftJoin('app_listings as al', (join) =>
      join.onRef('al.serial_id', '=', 'c.entityId').on('c.entityType', '=', 'appListing')
    )
    .select([
      'c.id',
      'c.entityType',
      'c.entityId',
      'cch.projectId as comicProjectId',
      'al.slug as appListingSlug',
    ])
    .where('c.id', '=', commentId)
    .where('c.deletedAt', 'is', null)
    .executeTakeFirst();

export type CommentPermalinkRow = NonNullable<Awaited<ReturnType<typeof getCommentPermalinkRow>>>;

export type CommentThreadTarget = {
  threadType: string;
  /** `null` for a slug-addressed entity, which has no id in its URL. */
  threadParentId: number | null;
  appListingSlug?: string | null;
};

/**
 * Entity types with no public route. They fall to `threadUrlMap`'s `'comment'` fallback in the
 * notification SQL and are unaddressable BY DESIGN; listed so the set is a decision, not a gap.
 */
export const UNADDRESSABLE_ENTITY_TYPES = ['model3dReview'] as const;

/**
 * The entity target for a comment, or `null` when it cannot be addressed.
 *
 * The addressability rule differs by how the entity is addressed, because the two failure modes
 * differ: a missing id renders `/posts/null`, a missing slug renders
 * `/apps/store-preview/undefined`. Both are 404s dressed as working links, so neither may pass.
 */
export const resolveCommentTarget = (
  row: Pick<CommentPermalinkRow, 'entityType' | 'entityId' | 'comicProjectId' | 'appListingSlug'>
): CommentThreadTarget | null => {
  if ((UNADDRESSABLE_ENTITY_TYPES as readonly string[]).includes(row.entityType)) return null;
  if (row.entityType === 'appListing')
    return row.appListingSlug
      ? { threadType: 'appListing', threadParentId: null, appListingSlug: row.appListingSlug }
      : null;
  if (row.entityType === 'comicChapter')
    return row.comicProjectId
      ? { threadType: 'comicChapter', threadParentId: row.comicProjectId }
      : null;
  return row.entityId ? { threadType: row.entityType, threadParentId: row.entityId } : null;
};

/**
 * The permalink for a comment, or `null` if its entity cannot be addressed — in which case the
 * page 404s. Resolves through the one `threadUrlMap` the notifications use, so a route rename
 * moves the permalink and the notification together.
 */
export const buildCommentPermalink = (
  row: CommentPermalinkRow | null | undefined
): string | null => {
  if (!row) return null;
  const target = resolveCommentTarget(row);
  if (!target) return null;
  const url = threadUrlMap({
    threadType: target.threadType,
    threadParentId: target.threadParentId,
    appListingSlug: target.appListingSlug,
    commentId: row.id,
    // Always pin the target comment as the thread root so it renders standalone via
    // RootThreadProvider's activeComment path. Sidesteps cursor-paginated thread fetches
    // (target may be on page N) and works uniformly for root and reply comments.
    commentParentType: 'comment',
    commentParentId: row.id,
  });

  return url ?? null;
};
