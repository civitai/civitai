import { NotificationCategory } from '~/server/common/enums';
import type { CommentType } from '~/server/clickhouse/tracker';
import type { Context, ProtectedContext } from '~/server/createContext';
import { dbRead } from '~/server/db/client';
import { articleShareCookieName } from '~/server/services/article-share.helpers';
import { getArticleByShareToken } from '~/server/services/article-share.service';
import { assertBountyVisible } from '~/server/services/bounty-visibility';
import { hasEntityAccess } from '~/server/services/common.service';
import { assertCrucibleVisible } from '~/server/services/crucible.service';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { getModelVisibleToViewer } from '~/server/services/model-visibility.service';
import { createNotification } from '~/server/services/notification.service';
import { assertStorylineVisible } from '~/server/services/storyline.service';
import { BlockedByUsers, BlockedUsers } from '~/server/services/user-preferences.service';
import type { StoredCommentV3 } from '~/server/services/commentv3/write.service';
import {
  handleLogError,
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { updateEntityMetric } from '~/server/utils/metric-helpers';
import {
  isComicProjectHidden,
  isPanelTainted,
  readerPanelsWhere,
} from '~/server/services/comics/chapter-visibility';
import { storylineReaderLevel } from '~/server/utils/storyline-reader-level';
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import {
  ArticleStatus,
  type CommentEntityType,
  ComicChapterStatus,
  ModelStatus,
} from '~/shared/utils/prisma/enums';

export type CommentReadContext = Pick<Context, 'user' | 'features' | 'req' | 'cache'>;

/**
 * What one kind of entity adds to the comment rules every surface shares. The owner is not here:
 * `getBlockCheckOwnerIds` resolves it for every current entity type; a new one needs a case there.
 */
type CommentSurface = {
  /** Throws not-found when the viewer may not see the entity's comments. Reads and writes. */
  assertVisible?(entityId: number, ctx: CommentReadContext): Promise<void>;
  /** Throws when the viewer may not write there: a create or an edit, or the owner's hide and pin. */
  assertWritable?(entityId: number, ctx: ProtectedContext): Promise<void>;
  /** Throws when the entity takes no new comments or edits; the owner may still hide and pin. */
  assertOpen?(entityId: number, ctx: ProtectedContext): Promise<void>;
  /** After a new comment commits: side effects only. */
  onCreated?(comment: StoredCommentV3, ctx: ProtectedContext): void;
  /** The ClickHouse comment event for a new comment, where it is not the default (`commentTrackTypes`). */
  trackAs?(comment: StoredCommentV3): { type: CommentType; entityId: number };
};

/** Creators who blocked the viewer and creators the viewer blocked. */
export async function getBlockedCreatorIds(userId: number) {
  const [blockedBy, blocked] = await Promise.all([
    BlockedByUsers.getCached({ userId }),
    BlockedUsers.getCached({ userId }),
  ]);
  return [...new Set([...blockedBy, ...blocked].map((x) => x.id))];
}

/** The storyline page's own gate, so a thread is never readable where its storyline is not. */
export async function assertStorylineThreadVisible(storylineId: number, ctx: CommentReadContext) {
  if (!getFeatureFlags(ctx).storylines) throw throwNotFoundError('Storyline not found');
  return assertStorylineVisible(storylineId, ctx.user, storylineReaderLevel(ctx, undefined));
}

export async function assertCrucibleCommentsVisible(crucibleId: number, ctx: CommentReadContext) {
  const { user } = ctx;
  await assertCrucibleVisible(crucibleId, {
    viewerId: user?.id,
    isModerator: !!user?.isModerator,
    isGreen: !!ctx.features?.isGreen,
    blockedCreatorIds: user && !user.isModerator ? await getBlockedCreatorIds(user.id) : [],
  });
}

const accessGated =
  (entityType: 'Article' | 'Post') => async (entityId: number, ctx: ProtectedContext) => {
    const [access] = await hasEntityAccess({
      entityType,
      entityIds: [entityId],
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    });
    if (!access?.hasAccess)
      throw throwAuthorizationError('You do not have access to this resource.');
  };

/** A model's comments are for whoever may see the model: published, or its owner's; not `poi`. */
async function assertModelCommentsVisible(modelId: number, ctx: CommentReadContext) {
  if (!(await getModelVisibleToViewer(modelId, ctx.user)))
    throw throwNotFoundError('Model not found');
}

/**
 * A model takes comments while neither it nor its comments are locked (`meta.commentsLocked`, which
 * the page enforces only by hiding the discussion) and it has a published version. With exactly one, the
 * writer needs access to it: an early-access version would otherwise be discussed by readers it
 * still excludes. With more, the latest may be early access while an older one is open.
 */
async function assertModelOpen(modelId: number, ctx: ProtectedContext) {
  const model = await dbRead.model.findUnique({
    where: { id: modelId },
    select: {
      locked: true,
      meta: true,
      modelVersions: {
        take: 2,
        select: { id: true },
        where: { status: ModelStatus.Published },
        orderBy: { index: 'asc' },
      },
    },
  });
  if (!model) throw throwNotFoundError('Model not found');
  const commentsLocked = !!(model.meta as { commentsLocked?: boolean } | null)?.commentsLocked;
  if ((model.locked || commentsLocked) && !ctx.user.isModerator)
    throw throwAuthorizationError(model.locked ? 'Model is locked' : 'Comments are locked');
  const [version] = model.modelVersions;
  if (!version) throw throwNotFoundError('This model has no versions.');
  if (model.modelVersions.length > 1) return;
  const [access] = await hasEntityAccess({
    entityType: 'ModelVersion',
    entityIds: [version.id],
    userId: ctx.user.id,
    isModerator: ctx.user.isModerator,
  });
  if (!access?.hasAccess)
    throw throwAuthorizationError("You do not have access to this model's latest version.");
}

/**
 * An unpublished article's comments are its owner's, moderators', and those of a viewer whose share
 * link for it still opens the draft (round 1's cookie, re-resolved on every call).
 */
async function assertArticleCommentsVisible(articleId: number, ctx: CommentReadContext) {
  const article = await dbRead.article.findUnique({
    where: { id: articleId },
    select: { userId: true, status: true },
  });
  if (!article) throw throwNotFoundError('Article not found');
  if (article.status === ArticleStatus.Published) return;
  // Signed-out reads are edge-cached by URL; a link holder's answer must never be served to anyone else.
  // `edgeCacheIt` on a commentv3 read would rewrite ctx.cache after this and undo it.
  if (ctx.cache)
    Object.assign(ctx.cache, { skip: true, canCache: false, edgeTTL: 0, browserTTL: 0 });
  if (ctx.user?.isModerator || article.userId === ctx.user?.id) return;
  const shared = await getArticleByShareToken({
    articleId,
    shareToken: ctx.req?.cookies?.[articleShareCookieName(articleId)],
    viewerId: ctx.user?.id,
  });
  if (shared.status !== 'ok') throw throwNotFoundError('Article not found');
}

/**
 * The comic reader's chapter rules (`comics/chapter-visibility.ts`), but not its `comicCreator`
 * flag or its early-access panel lock.
 */
async function assertComicChapterVisible(chapterId: number, ctx: CommentReadContext) {
  const chapter = await dbRead.comicChapter.findUnique({
    where: { id: chapterId },
    select: {
      status: true,
      panels: {
        where: readerPanelsWhere,
        select: { image: { select: { tosViolation: true, needsReview: true, ingestion: true } } },
      },
      project: {
        select: {
          userId: true,
          status: true,
          tosViolation: true,
          publishedAt: true,
          nsfwLevel: true,
          user: { select: { bannedAt: true } },
        },
      },
    },
  });
  if (
    !chapter ||
    chapter.panels.length === 0 ||
    (ctx.features?.isGreen &&
      chapter.project.nsfwLevel !== 0 &&
      Flags.intersects(chapter.project.nsfwLevel, nsfwBrowsingLevelsFlag)) ||
    (await isComicProjectHidden(chapter.project, ctx.user))
  )
    throw throwNotFoundError('Chapter not found');
  if (ctx.user?.isModerator || chapter.project.userId === ctx.user?.id) return;
  if (chapter.status !== ComicChapterStatus.Published || chapter.panels.some(isPanelTainted))
    throw throwNotFoundError('Chapter not found');
}

/**
 * Tells the project owner about a new top-level comment on a chapter, deep-linked to it. Shares the
 * comment's `comment:v2:<id>` dedupe key with the thread notifications, and is queued first, so the
 * owner gets this one.
 */
async function notifyComicOwner(comment: StoredCommentV3, ctx: ProtectedContext) {
  if (comment.parentId) return;
  const chapter = await dbRead.comicChapter.findUnique({
    where: { id: comment.entityId },
    select: {
      projectId: true,
      position: true,
      name: true,
      project: { select: { userId: true, name: true } },
    },
  });
  if (!chapter || chapter.project.userId === comment.userId) return;
  await createNotification({
    type: 'new-comic-comment',
    key: `new-comic-comment:${chapter.projectId}:${chapter.position}:${comment.id}`,
    category: NotificationCategory.Comment,
    dedupeKey: `comment:v2:${comment.id}`,
    userId: chapter.project.userId,
    details: {
      comicProjectId: String(chapter.projectId),
      comicProjectName: chapter.project.name,
      chapterName: chapter.name,
      commenterUsername: ctx.user.username ?? 'Someone',
      chapterPosition: chapter.position,
      commentId: comment.id,
    },
  });
}

/** Every entity type with a comment section, so a new one does not compile until it has an entry. */
export const commentSurfaces: Record<CommentEntityType, CommentSurface> = {
  article: { assertVisible: assertArticleCommentsVisible, assertWritable: accessGated('Article') },
  post: { assertWritable: accessGated('Post') },
  image: {
    onCreated: (comment, ctx) => {
      if (comment.parentId) return;
      void updateEntityMetric({
        ctx,
        entityType: 'Image',
        entityId: comment.entityId,
        metricType: 'Comment',
      });
    },
  },
  review: {},
  bounty: {
    assertVisible: (bountyId, ctx) => assertBountyVisible({ bountyId }, ctx.user),
  },
  bountyEntry: {
    assertVisible: (entryId, ctx) => assertBountyVisible({ entryId }, ctx.user),
  },
  crucible: { assertVisible: assertCrucibleCommentsVisible },
  storyline: {
    assertVisible: async (id, ctx) => void (await assertStorylineThreadVisible(id, ctx)),
    assertWritable: async (id, ctx) => {
      if (ctx.user.isModerator) return;
      const storyline = await dbRead.storyline.findUnique({
        where: { id },
        select: { tosViolation: true },
      });
      if (storyline?.tosViolation)
        throw throwAuthorizationError('This storyline has been taken down.');
    },
  },
  challenge: {},
  comicChapter: {
    assertVisible: assertComicChapterVisible,
    onCreated: (comment, ctx) => void notifyComicOwner(comment, ctx).catch(handleLogError),
  },
  model: {
    assertVisible: assertModelCommentsVisible,
    assertOpen: assertModelOpen,
    // Every comment, replies too, keyed by the model: the model metrics job finds models to recount
    // by this event.
    trackAs: (comment) => ({ type: 'Model', entityId: comment.entityId }),
  },
  model3d: {},
  // Nothing renders these comments, and the surface never wrote CommentV3.
  model3dReview: {
    assertWritable: async () => {
      throw throwBadRequestError('Comments on 3D model reviews are closed.');
    },
  },
  appListing: {},
  // Storyline text items: the thread opens with its visibility rule.
  postText: {
    assertVisible: async () => {
      throw throwNotFoundError('Text not found');
    },
    // Moderators skip assertVisible, and an edit asks only this.
    assertWritable: async () => {
      throw throwBadRequestError('Comments on storyline text are closed.');
    },
  },
};

export function commentSurface(entityType: string): CommentSurface {
  if (!Object.hasOwn(commentSurfaces, entityType))
    throw throwNotFoundError(`No comments on ${entityType}`);
  return commentSurfaces[entityType as keyof typeof commentSurfaces];
}
