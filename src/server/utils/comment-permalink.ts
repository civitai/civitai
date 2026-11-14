import { sql } from 'kysely';
import { kyselyRead } from '~/server/db/kyselyDb';
import { postTextAnchorImage, threadUrlMap } from '~/server/notifications/comment.notifications';

/**
 * What `/comments/<id>` reads: the comment's entity, plus the addresses that are not the entity id.
 * A comic chapter is addressed by its project and position, an app listing by its slug (`entityId`
 * is `app_listings.serial_id`, an integer that appears nowhere in the URL), and a storyline text by
 * its anchor image. A deleted
 * comment has no permalink: a placeholder in a section is reached through its replies. Nor, but for
 * a moderator, does one hidden for ToS.
 */
export const getCommentPermalinkRow = (commentId: number, { includeHidden = false } = {}) =>
  kyselyRead
    .selectFrom('CommentV3 as c')
    .leftJoin('ComicChapter as cch', (join) =>
      join.onRef('cch.id', '=', 'c.entityId').on('c.entityType', '=', 'comicChapter')
    )
    .leftJoin('app_listings as al', (join) =>
      join.onRef('al.serial_id', '=', 'c.entityId').on('c.entityType', '=', 'appListing')
    )
    .leftJoin('PostText as ptx', (join) =>
      join.onRef('ptx.id', '=', 'c.entityId').on('c.entityType', '=', 'postText')
    )
    .select([
      sql<number | null>`${sql.raw(postTextAnchorImage('ptx'))}`.as('postTextAnchorImageId'),
      'c.id',
      'c.entityType',
      'c.entityId',
      'cch.projectId as comicProjectId',
      'cch.position as comicChapterPosition',
      'al.slug as appListingSlug',
    ])
    .where('c.id', '=', commentId)
    .where('c.deletedAt', 'is', null)
    .$if(!includeHidden, (qb) => qb.where('c.tosViolation', '=', false))
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
  row: Pick<
    CommentPermalinkRow,
    'entityType' | 'entityId' | 'comicProjectId' | 'appListingSlug' | 'postTextAnchorImageId'
  >
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
  // A text in a post with no image has no slide URL.
  if (row.entityType === 'postText')
    return row.postTextAnchorImageId
      ? { threadType: 'postText', threadParentId: row.postTextAnchorImageId }
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
    comicChapterPosition: row.comicChapterPosition,
    postTextId: row.entityId,
    commentId: row.id,
    // Always pin the target comment as the thread root, so it renders standalone: no cursor-paginated
    // thread fetch (the target may be on page N), and root and reply comments behave alike.
    commentParentType: 'comment',
    commentParentId: row.id,
  });

  return url ?? null;
};
