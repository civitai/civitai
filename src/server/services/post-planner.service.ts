import { Prisma } from '@prisma/client';
import sanitize from 'sanitize-html';
import {
  addMinutes,
  getPostScheduleError,
  getPostScheduleScope,
  POST_BATCH_MIN_GAP_MINUTES,
  validateBatchSchedule,
  type PostScheduleScope,
  type PostScheduleTarget,
} from '@civitai/shared/post-scheduling';
import type { Context, ProtectedContext } from '~/server/createContext';
import type { modelRouter } from '~/server/routers/model.router';
import type { modelVersionRouter } from '~/server/routers/model-version.router';
import { dbRead, dbWrite } from '~/server/db/client';
import { postStatCache, userPostCountCache } from '~/server/redis/caches';
import { getDailyPostLimit } from '~/server/schema/post.schema';
import { preventReplicationLagBatch } from '~/server/db/db-lag-helpers';
import { queueImageSearchIndexUpdate } from '~/server/services/image.service';
import { getPostEditDetail, getPostResources, updatePost } from '~/server/services/post.service';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwConflictError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { ModelStatus } from '~/shared/utils/prisma/enums';
import type { MediaType } from '~/shared/utils/prisma/enums';
import type { SessionUser } from '~/types/session';
import { uniq, uniqBy } from 'lodash-es';

// A burst scheduler posts 25+ a day; a six-week month grid must hold all of it before the UI has to
// say "incomplete". A row serialises to ~210 bytes, so 1,500 is ~300 KiB before compression.
const PLANNER_PAGE_LIMIT = 1500;
export const SCHEDULE_CHANGED_MESSAGE = "This post's schedule changed. Refresh and try again.";

export type PlannerRelease = {
  scope: Exclude<PostScheduleScope, 'post'>;
  modelName: string;
  versionName: string;
};

export type PlannerPost = {
  id: number;
  title: string | null;
  publishedAt: string;
  modelVersionId: number | null;
  nsfwLevel: number;
  imageCount: number;
  cover: { url: string; type: MediaType } | null;
  release: PlannerRelease | null;
};

export type PlannerPostDetail = PlannerPost & {
  description: string | null;
  media: {
    id: number;
    url: string;
    type: MediaType;
    nsfwLevel: number;
    width: number;
    height: number;
  }[];
  model: { id: number; name: string; versionName: string } | null;
  resources: { id: number; name: string; type: string; modelId: number; versionId: number }[];
  tools: string[];
  techniques: string[];
  tags: string[];
  /** Null until the post is live; posts have no stored view count, so this is reactions only. */
  stats: { reactions: number; comments: number } | null;
};

type ReleaseRow = {
  versionStatus: ModelStatus | null;
  versionName: string | null;
  modelName: string | null;
  modelStatus: ModelStatus | null;
  modelUserId: number | null;
};

function releaseOf(post: { userId: number } & ReleaseRow): PlannerRelease | null {
  const scope = getPostScheduleScope({
    userId: post.userId,
    modelVersion:
      post.versionStatus && post.modelStatus && post.modelUserId !== null
        ? {
            status: post.versionStatus,
            model: { userId: post.modelUserId, status: post.modelStatus },
          }
        : null,
  });
  if (scope === 'post') return null;
  return { scope, modelName: post.modelName ?? '', versionName: post.versionName ?? '' };
}

/** Block boundaries become line breaks; the planner renders the result as text, never as HTML. */
function stripHtml(html: string): string {
  const text = sanitize(html.replace(/<\/(p|div|li|h[1-6]|blockquote|pre)>|<br\s*\/?>/gi, '$&\n'), {
    allowedTags: [],
    allowedAttributes: {},
  });
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

type ScheduledPostRow = {
  id: number;
  title: string | null;
  publishedAt: Date;
  modelVersionId: number | null;
  nsfwLevel: number;
  imageCount: number;
  coverUrl: string | null;
  coverType: MediaType | null;
} & ReleaseRow;

export async function getScheduledPosts({
  user,
  from,
  to,
  modelVersionId,
}: {
  user: SessionUser;
  from: Date;
  to: Date;
  modelVersionId?: number;
}) {
  const rows = await dbRead.$queryRaw<ScheduledPostRow[]>`
    SELECT
      p.id,
      p.title,
      p."publishedAt",
      p."modelVersionId",
      p."nsfwLevel",
      mv.status AS "versionStatus",
      mv.name AS "versionName",
      m.name AS "modelName",
      m.status AS "modelStatus",
      m."userId" AS "modelUserId",
      COALESCE(cover.count, 0)::int AS "imageCount",
      cover.url AS "coverUrl",
      cover.type AS "coverType"
    FROM "Post" p
    LEFT JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
    LEFT JOIN "Model" m ON m.id = mv."modelId"
    LEFT JOIN LATERAL (
      SELECT i.url, i.type, COUNT(*) OVER () AS count FROM "Image" i
      WHERE i."postId" = p.id
      ORDER BY i.index ASC NULLS LAST, i.id ASC
      LIMIT 1
    ) cover ON TRUE
    WHERE p."userId" = ${user.id}
      AND p."publishedAt" >= ${from}
      AND p."publishedAt" < ${to}
      ${modelVersionId ? Prisma.sql`AND p."modelVersionId" = ${modelVersionId}` : Prisma.empty}
    ORDER BY p."publishedAt" ASC, p.id ASC
    LIMIT ${PLANNER_PAGE_LIMIT + 1}
  `;

  const truncated = rows.length > PLANNER_PAGE_LIMIT;
  const posts: PlannerPost[] = rows.slice(0, PLANNER_PAGE_LIMIT).map((row) => ({
    id: row.id,
    title: row.title,
    publishedAt: row.publishedAt.toISOString(),
    modelVersionId: row.modelVersionId,
    nsfwLevel: row.nsfwLevel,
    imageCount: row.imageCount,
    cover: row.coverUrl && row.coverType ? { url: row.coverUrl, type: row.coverType } : null,
    release: releaseOf({ userId: user.id, ...row }),
  }));

  return {
    posts,
    dailyLimit: getDailyPostLimit(user),
    minGapMinutes: POST_BATCH_MIN_GAP_MINUTES,
    truncated,
  };
}

export async function getPlannerPostDetail({
  id,
  user,
}: {
  id: number;
  user: SessionUser;
}): Promise<PlannerPostDetail> {
  const post = await getPostEditDetail({ id, user });
  // The planner is the owner's own calendar; `getPostEditDetail` also admits moderators.
  if (post.user.id !== user.id) throw throwAuthorizationError();

  const live = !!post.publishedAt && post.publishedAt <= new Date();
  const [resources, version, stats] = await Promise.all([
    getPostResources({ id }),
    post.modelVersionId
      ? dbRead.modelVersion.findUnique({
          where: { id: post.modelVersionId },
          select: {
            id: true,
            name: true,
            status: true,
            model: { select: { id: true, name: true, status: true, userId: true } },
          },
        })
      : null,
    live ? postStatCache.fetch([id]) : null,
  ]);

  const media = post.images.map((image) => ({
    id: image.id,
    url: image.url,
    type: image.type,
    nsfwLevel: image.nsfwLevel,
    width: image.width ?? 0,
    height: image.height ?? 0,
  }));
  const cover = media[0] ? { url: media[0].url, type: media[0].type } : null;
  const metric = stats?.[id];

  return {
    id: post.id,
    title: post.title,
    publishedAt: post.publishedAt?.toISOString() ?? '',
    modelVersionId: post.modelVersionId,
    nsfwLevel: post.nsfwLevel,
    imageCount: media.length,
    cover,
    release: releaseOf({
      userId: post.user.id,
      versionStatus: version?.status ?? null,
      versionName: version?.name ?? null,
      modelName: version?.model.name ?? null,
      modelStatus: version?.model.status ?? null,
      modelUserId: version?.model.userId ?? null,
    }),
    description: post.detail ? stripHtml(post.detail) : null,
    media,
    model: version
      ? { id: version.model.id, name: version.model.name, versionName: version.name }
      : null,
    // One row per image and resource; the drawer lists each resource once.
    resources: uniqBy(resources, (resource) => resource.modelVersionId).flatMap((resource) =>
      resource.modelId !== null
        ? [
            {
              id: resource.modelVersionId,
              name: resource.modelName ?? resource.name ?? '',
              type: resource.modelType ?? '',
              modelId: resource.modelId,
              versionId: resource.modelVersionId,
            },
          ]
        : []
    ),
    tools: uniq(post.images.flatMap((image) => image.tools.map((tool) => tool.name))),
    techniques: uniq(
      post.images.flatMap((image) => image.techniques.map((technique) => technique.name))
    ),
    tags: post.tags.map((tag) => tag.name),
    stats: metric
      ? {
          reactions: metric.likeCount + metric.heartCount + metric.laughCount + metric.cryCount,
          comments: metric.commentCount,
        }
      : null,
  };
}

const schedulablePostSelect = {
  id: true,
  userId: true,
  publishedAt: true,
  modelVersionId: true,
  modelVersion: {
    select: {
      id: true,
      status: true,
      modelId: true,
      model: { select: { userId: true, status: true } },
    },
  },
} satisfies Prisma.PostSelect;

export type PlannerScheduleResult = {
  publishedAt: string;
  scope: PostScheduleScope;
  movedPostIds: number[];
};

type PublishCallers = {
  model: (ctx: Context) => ReturnType<typeof modelRouter.createCaller>;
  version: (ctx: Context) => ReturnType<typeof modelVersionRouter.createCaller>;
};
let publishCallers: PublishCallers | null = null;

// A release move IS `model.publish` / `modelVersion.publish`, so it runs through those procedures:
// their muted, email-verification, token-scope (with its audit row) and ownership guards stay
// theirs. Dynamic imports keep the routers out of this service's load-time graph.
async function getPublishCallers(): Promise<PublishCallers> {
  if (!publishCallers) {
    const [{ createCallerFactory }, { modelRouter }, { modelVersionRouter }] = await Promise.all([
      import('~/server/trpc'),
      import('~/server/routers/model.router'),
      import('~/server/routers/model-version.router'),
    ]);
    publishCallers = {
      model: createCallerFactory(modelRouter),
      version: createCallerFactory(modelVersionRouter),
    };
  }
  return publishCallers;
}

/**
 * Moves one scheduled post to `target` (`'now'` publishes it). A post that goes live with a
 * scheduled release is moved by moving the release through the same controllers as
 * `model.publish` / `modelVersion.publish`, which fan the date out to the owner's other
 * still-scheduled posts on that version — those are `movedPostIds`.
 */
export async function reschedulePlannerPost({
  id,
  target,
  expectedScope,
  ctx,
}: {
  id: number;
  target: PostScheduleTarget;
  expectedScope: PostScheduleScope;
  ctx: ProtectedContext;
}): Promise<PlannerScheduleResult> {
  const { user } = ctx;
  const post = await dbWrite.post.findUnique({ where: { id }, select: schedulablePostSelect });
  if (!post || post.userId !== user.id) throw throwNotFoundError('Post not found');

  const now = new Date();
  const refusal = getPostScheduleError(post, target, now);
  if (refusal) throw throwBadRequestError(refusal);

  const scope = getPostScheduleScope(post);
  // The UI decided drop-commits-vs-confirm from a replica read; a stale one must not turn a chip
  // drop into a release move.
  if (scope !== expectedScope) throw throwConflictError(SCHEDULE_CHANGED_MESSAGE);
  const publishedAt = target === 'now' ? undefined : target;

  if (scope === 'post') {
    const requested = publishedAt ?? now;
    const updated = await updatePost({ id: post.id, publishedAt: requested, user });
    // `updatePost` only writes while the post is still in the future; losing that race leaves
    // the row as it was.
    if (updated.publishedAt?.getTime() !== requested.getTime())
      throw throwConflictError('This post was published before it could be moved');
    return { publishedAt: updated.publishedAt.toISOString(), scope, movedPostIds: [] };
  }

  const version = post.modelVersion as NonNullable<typeof post.modelVersion>;
  if (scope === 'model') {
    // The model's date moves with this version, so a sibling scheduled earlier would go live
    // under a model that is still Scheduled.
    const otherScheduled = await dbWrite.modelVersion.count({
      where: { modelId: version.modelId, status: ModelStatus.Scheduled, id: { not: version.id } },
    });
    if (otherScheduled > 0)
      throw throwBadRequestError(
        'This model has other scheduled versions. Reschedule it from the model page.'
      );
    const callers = await getPublishCallers();
    await callers
      .model(ctx)
      .publish({ id: version.modelId, versionIds: [version.id], publishedAt });
  } else {
    const callers = await getPublishCallers();
    await callers.version(ctx).publish({ id: version.id, publishedAt });
  }

  const after = await dbWrite.post.findUnique({
    where: { id: post.id },
    select: { publishedAt: true },
  });
  const moved =
    !!after?.publishedAt &&
    (publishedAt
      ? after.publishedAt.getTime() === publishedAt.getTime()
      : after.publishedAt <= new Date());
  if (!moved || !after?.publishedAt)
    throw throwConflictError('The release was updated but this post did not move');

  const siblings = await dbWrite.post.findMany({
    where: {
      userId: user.id,
      modelVersionId: version.id,
      id: { not: post.id },
      publishedAt: after.publishedAt,
    },
    select: { id: true },
  });

  return {
    publishedAt: after.publishedAt.toISOString(),
    scope,
    movedPostIds: siblings.map((sibling) => sibling.id),
  };
}

async function loadOwnScheduledPosts({ ids, user }: { ids: number[]; user: SessionUser }) {
  const posts = await dbWrite.post.findMany({
    where: { id: { in: ids }, userId: user.id, publishedAt: { gt: new Date() } },
    select: schedulablePostSelect,
  });
  const standalone = posts.filter((post) => getPostScheduleScope(post) === 'post');
  const skippedReleaseIds = posts
    .filter((post) => getPostScheduleScope(post) !== 'post')
    .map((post) => post.id);
  return { standalone, skippedReleaseIds };
}

export async function unschedulePlannerPosts({ ids, user }: { ids: number[]; user: SessionUser }) {
  const { standalone, skippedReleaseIds } = await loadOwnScheduledPosts({ ids, user });
  if (!standalone.length) return { unscheduledIds: [] as number[], skippedReleaseIds };

  const rows = await dbWrite.$queryRaw<{ id: number }[]>`
    UPDATE "Post"
    SET "publishedAt" = NULL
    WHERE id IN (${Prisma.join(standalone.map((post) => post.id))})
      AND "userId" = ${user.id}
      AND "publishedAt" > NOW()
    RETURNING id
  `;
  const unscheduledIds = rows.map((row) => row.id);

  if (unscheduledIds.length) await afterPostsRescheduled(unscheduledIds, user.id);

  return { unscheduledIds, skippedReleaseIds };
}

/** A date change on a still-future post: reindex its images and keep the owner's counts fresh. */
async function afterPostsRescheduled(postIds: number[], userId: number) {
  await preventReplicationLagBatch('post', postIds);
  const images = await dbWrite.image.findMany({
    where: { postId: { in: postIds } },
    select: { id: true },
  });
  if (images.length)
    await queueImageSearchIndexUpdate({
      ids: images.map((image) => image.id),
      action: SearchIndexUpdateQueueAction.Update,
    });
  await userPostCountCache.refresh(userId);
}

export async function shiftPlannerPosts({
  ids,
  deltaMinutes,
  user,
}: {
  ids: number[];
  deltaMinutes: number;
  user: SessionUser;
}) {
  const now = new Date();
  const { standalone, skippedReleaseIds } = await loadOwnScheduledPosts({ ids, user });
  if (!standalone.length)
    return { moved: [] as { id: number; publishedAt: string }[], skippedReleaseIds };

  const targets = standalone.map((post) => ({
    id: post.id,
    current: post.publishedAt as Date,
    publishedAt: addMinutes(post.publishedAt as Date, deltaMinutes),
  }));
  const issues = targets.flatMap(({ current, publishedAt }) => {
    const refusal = getPostScheduleError({ publishedAt: current }, publishedAt, now);
    return refusal ? [refusal] : [];
  });

  const startOfTodayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const others = await dbWrite.post.findMany({
    where: {
      userId: user.id,
      publishedAt: { gte: startOfTodayUtc },
      id: { notIn: targets.map((target) => target.id) },
    },
    select: { publishedAt: true },
  });
  const validation = validateBatchSchedule({
    now,
    publishedAts: targets.map((target) => target.publishedAt),
    existingPublishedAts: others.map((other) => other.publishedAt as Date),
    dailyLimit: getDailyPostLimit(user),
    minGapMinutes: POST_BATCH_MIN_GAP_MINUTES,
  });
  issues.push(...validation.issues.map((issue) => issue.message));
  if (issues.length) throw throwBadRequestError(uniq(issues).join(' '));

  const rows = await dbWrite.$queryRaw<{ id: number; publishedAt: Date }[]>`
    UPDATE "Post" p
    SET "publishedAt" = t."publishedAt"
    FROM (VALUES ${Prisma.join(
      targets.map((t) => Prisma.sql`(${t.id}, ${t.publishedAt}::timestamp)`)
    )}) AS t(id, "publishedAt")
    WHERE p.id = t.id
      AND p."userId" = ${user.id}
      AND p."publishedAt" > NOW()
    RETURNING p.id, p."publishedAt"
  `;
  const moved = rows.map((row) => ({ id: row.id, publishedAt: row.publishedAt.toISOString() }));
  if (moved.length)
    await afterPostsRescheduled(
      moved.map((row) => row.id),
      user.id
    );
  if (moved.length !== targets.length)
    throw throwConflictError(
      `${moved.length} of ${targets.length} posts moved; the rest were published before they could be. Refresh to see the current schedule.`
    );

  return { moved, skippedReleaseIds };
}
