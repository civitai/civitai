import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import {
  validateBatchSchedule as validateBatchScheduleDates,
  type ScheduleIssue,
  type SchedulePerDay,
} from '@civitai/shared/post-scheduling';
import { Prisma } from '@prisma/client';
import { createPostHandler, updatePostHandler } from '~/server/controllers/post.controller';
import type { ProtectedContext } from '~/server/createContext';
import { dbWrite } from '~/server/db/client';
import { preventReplicationLag } from '~/server/db/db-lag-helpers';
import { withPostScheduleLock } from '~/server/services/post-schedule-lock';
import { logToAxiom } from '~/server/logging/client';
import { trpcSlowLogThresholdMs } from '~/server/logging/trpc-slow-log';
import { ImageIngestionStatus, ModelStatus } from '~/shared/utils/prisma/enums';
import { sysRedis, type RedisKeyTemplateSys } from '~/server/redis/client';
import { getDailyPostLimit } from '~/server/schema/post.schema';
import type {
  BatchMediaStatusInput,
  PersistBatchMediaInput,
  RemoveBatchMediaInput,
  ScheduleBatchInput,
  ValidateBatchScheduleInput,
} from '~/server/schema/post.schema';
import {
  addImageTechniques,
  addImageTools,
  createImage,
  createImageResources,
  deleteImages,
  enqueueImageIngestion,
} from '~/server/services/image.service';
import {
  canViewModelVersion,
  MODEL_VERSION_NOT_FOUND,
  modelVersionVisibilitySelect,
} from '~/server/services/model-version-visibility.service';
import { resolveVerifiedSourceImageIds } from '~/server/services/orchestrator/remix-provenance';
import {
  addResourceToPostImage,
  bustCachesForPosts,
  resolveMetaToolAndTechnique,
  updatePostNsfwLevel,
} from '~/server/services/post.service';
import { bustCacheTag } from '~/server/utils/cache-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { userUnderLegalHoldSql } from '~/server/utils/legal-hold';
import {
  handleLogError,
  throwBadRequestError,
  throwConflictError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import type { SessionUser } from '~/types/session';
import { canAddManualResources } from '~/utils/manual-image-resources';

/**
 * Stamped into `Image.metadata` on every row `persistBatchMedia` creates. A row with it and no
 * post is a composer draft: the status, remove and adopt paths accept nothing else, and
 * `batch-draft-images-cleanup` reaps the ones nobody scheduled.
 */
export const BATCH_DRAFT_METADATA_KEY = 'batchDraft';
/** Postless draft rows older than this are deleted by `batch-draft-images-cleanup`. */
export const BATCH_DRAFT_RETENTION_DAYS = 7;

const batchDraftFilter = {
  postId: null,
  metadata: { path: [BATCH_DRAFT_METADATA_KEY], equals: true },
} satisfies Prisma.ImageWhereInput;

/** The marker key as a SQL literal: a bound parameter would not match the partial index
 *  (`Image_batchDraft_createdAt_idx`) under a generic plan. A server constant, never input. */
const batchDraftKeyLiteral = () => Prisma.raw(`'${BATCH_DRAFT_METADATA_KEY}'`);

/**
 * A draft row that may be deleted: postless, marked, and under none of the holds other image
 * cleanup respects. Only valid on a statement over an unaliased "Image". The first two conjuncts
 * are the partial index's predicate, spelled the same.
 */
export function batchDraftDeletableSql() {
  return Prisma.sql`
    "Image"."postId" IS NULL
    AND ("Image".metadata->>${batchDraftKeyLiteral()}) = 'true'
    AND "Image"."needsReview" IS DISTINCT FROM 'appeal'
    AND "Image"."needsReview" IS DISTINCT FROM 'csam'
    AND NOT ${userUnderLegalHoldSql(Prisma.raw('"Image"."userId"'))}
  `;
}

export type BatchScheduleValidationResult = {
  ok: boolean;
  issues: ScheduleIssue[];
  dailyLimit: number;
  perDay: SchedulePerDay[];
};

export type ScheduleBatchResult = {
  /** In `posts` order. `alreadyCreated` marks a post an earlier attempt made; its `publishedAt` is
   *  the one that attempt set, whatever this request asked for. */
  created: { postId: number; publishedAt: string; alreadyCreated?: true }[];
  /** Index into `posts` of the one that failed; it was deleted, the ones before it stay. */
  failedAt?: number;
  message?: string;
};

const POST_FAILED_MESSAGE = 'Something went wrong while creating this post. Try again.';

export type PersistBatchMediaResult = { images: { url: string; imageId: number }[] };

/**
 * Creates the `Image` rows for finished uploads with no post, so the normal scan runs while the
 * creator is still composing. `scheduleBatch` adopts them into the posts it creates.
 */
export async function persistBatchMedia({
  input,
  user,
}: {
  input: PersistBatchMediaInput;
  user: SessionUser;
}): Promise<PersistBatchMediaResult> {
  const images: PersistBatchMediaResult['images'] = [];
  for (const { generationWorkflowId, metadata, ...image } of input.images) {
    const verifiedSourceImageIds = await resolveVerifiedSourceImageIds({
      userId: user.id,
      provenance: (image.meta?.extra as { provenance?: unknown } | undefined)?.provenance,
      workflowId: generationWorkflowId,
    });
    const { toolId, techniqueId } = await resolveMetaToolAndTechnique(image.meta);
    const created = await createImage({
      ...image,
      metadata: { ...metadata, [BATCH_DRAFT_METADATA_KEY]: true },
      verifiedSourceImageIds,
      userId: user.id,
      toolIds: toolId ? [toolId] : undefined,
      techniqueIds: techniqueId ? [techniqueId] : undefined,
    });
    // Before the scan result lands: its review rules read the image's resources.
    await createImageResources({ imageId: created.id }).catch(handleLogError);
    images.push({ url: image.url, imageId: created.id });
  }
  return { images };
}

export type BatchMediaStatus = {
  ingestion: ImageIngestionStatus;
  nsfwLevel: number;
  blockedFor: string | null;
  needsReview: string | null;
  minor: boolean;
  poi: boolean;
};
export type BatchMediaStatusResult = { images: Record<number, BatchMediaStatus> };

/** Only the caller's still-postless drafts; an id that is not one is absent from the result. */
export async function getBatchMediaStatus({
  input,
  user,
}: {
  input: BatchMediaStatusInput;
  user: SessionUser;
}): Promise<BatchMediaStatusResult> {
  // dbWrite: a row persisted a moment ago that the replica has not seen would read as gone, and
  // the composer drops what is gone.
  const rows = await dbWrite.image.findMany({
    where: { id: { in: input.ids }, userId: user.id, ...batchDraftFilter },
    select: {
      id: true,
      ingestion: true,
      nsfwLevel: true,
      blockedFor: true,
      needsReview: true,
      minor: true,
      poi: true,
    },
  });
  const images: BatchMediaStatusResult['images'] = {};
  for (const { id, ...status } of rows) images[id] = status;
  return { images };
}

export type RemoveBatchMediaResult = { removed: number[] };

/** Deletes the caller's still-postless drafts among `ids`, files included; other rows are skipped. */
export async function removeBatchMedia({
  input,
  user,
}: {
  input: RemoveBatchMediaInput;
  user: SessionUser;
}): Promise<RemoveBatchMediaResult> {
  const deleted = await deleteImages(input.ids, false, {
    onlyWhere: Prisma.sql`"Image"."userId" = ${user.id} AND ${batchDraftDeletableSql()}`,
  });
  return { removed: deleted.map((image) => image.id) };
}

// On dbWrite: a post the previous chunk created seconds ago must count against this one.
async function loadBatchScheduleContext(user: SessionUser, now: Date) {
  const startOfTodayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const rows = await dbWrite.$queryRaw<{ publishedAt: Date }[]>`
    SELECT "publishedAt" FROM "Post" WHERE "userId" = ${user.id} AND "publishedAt" >= ${startOfTodayUtc}
  `;
  return {
    dailyLimit: getDailyPostLimit(user),
    existingPublishedAts: rows.map((row) => row.publishedAt),
  };
}

export async function validateBatchSchedule({
  input,
  user,
}: {
  input: ValidateBatchScheduleInput;
  user: SessionUser;
}): Promise<BatchScheduleValidationResult> {
  const now = new Date();
  const { dailyLimit, existingPublishedAts } = await loadBatchScheduleContext(user, now);
  const { ok, issues, perDay } = validateBatchScheduleDates({
    now,
    publishedAts: input.publishedAts,
    existingPublishedAts,
    dailyLimit: user.isModerator ? Infinity : dailyLimit,
  });
  return { ok, issues, dailyLimit, perDay };
}

async function assertCanViewModelVersion(modelVersionId: number, user: SessionUser) {
  const version = await dbWrite.modelVersion.findUnique({
    where: { id: modelVersionId },
    select: modelVersionVisibilitySelect,
  });
  if (!version || !(await canViewModelVersion(version, user)))
    throw throwNotFoundError(MODEL_VERSION_NOT_FOUND);
}

async function assertCanUseModelVersion(modelVersionId: number, user: SessionUser) {
  const version = await dbWrite.modelVersion.findUnique({
    where: { id: modelVersionId },
    select: modelVersionVisibilitySelect,
  });
  if (!version || !(await canViewModelVersion(version, user)))
    throw throwNotFoundError(MODEL_VERSION_NOT_FOUND);
  // Publishing or rescheduling a version moves every pending post on it to the release instant,
  // which would collapse a spread-out batch past the gap and the cap.
  if (version.model.status !== ModelStatus.Published)
    throw throwBadRequestError('This model is not published, so it cannot be promoted.');
  if (version.status !== ModelStatus.Published)
    throw throwBadRequestError('Publish this version before promoting it with a batch.');
}

/** Drops a half-made post and hands its images back to the draft: the creator retries with the
 *  same image ids, which `deletePost` would have deleted along with their files. */
async function discardFailedPost(postId: number) {
  await dbWrite.$executeRaw`
    UPDATE "Image"
    SET "postId" = NULL, "index" = NULL,
        metadata = metadata || jsonb_build_object(${batchDraftKeyLiteral()}, true)
    WHERE "postId" = ${postId}
  `;
  await dbWrite.post.delete({ where: { id: postId } });
}

/** `modelVersionId`s per image, to tell what adoption added. */
async function listImageResources(imageIds: number[]) {
  if (!imageIds.length) return new Map<number, Set<number>>();
  const rows = await dbWrite.imageResourceNew.findMany({
    where: { imageId: { in: imageIds } },
    select: { imageId: true, modelVersionId: true },
  });
  const byImage = new Map<number, Set<number>>();
  for (const row of rows) {
    if (!byImage.has(row.imageId)) byImage.set(row.imageId, new Set());
    byImage.get(row.imageId)?.add(row.modelVersionId);
  }
  return byImage;
}

/**
 * Moves the post's draft rows under it, in order, and runs what `addPostImage` would have run on
 * the way: resources from the meta and the post's version, the post's level and the caches that
 * list the post. The `where` repeats the draft conjuncts, so a row that is gone, someone else's or
 * already on a post comes back as a short count and the post is discarded.
 */
async function adoptBatchMedia({
  images,
  postId,
  user,
}: {
  images: { imageId: number }[];
  postId: number;
  user: SessionUser;
}): Promise<number[]> {
  const imageIds = images.map((image) => image.imageId);
  for (const [index, imageId] of imageIds.entries()) {
    const count = await dbWrite.$executeRaw`
      UPDATE "Image"
      SET "postId" = ${postId}, "index" = ${index},
          metadata = metadata - ${batchDraftKeyLiteral()}
      WHERE id = ${imageId} AND "userId" = ${user.id} AND "postId" IS NULL
        AND (metadata->>${batchDraftKeyLiteral()}) = 'true'
    `;
    if (count !== 1)
      throw throwBadRequestError(
        'One of the uploads in this post is no longer available. Remove it and try again.'
      );
  }
  await limitConcurrency(
    imageIds.map((imageId) => () => createImageResources({ imageId }).catch(handleLogError)),
    10
  );
  await updatePostNsfwLevel(postId);
  await Promise.all([
    bustCacheTag(`images-user:${user.id}`),
    preventReplicationLag('postImages', postId),
    bustCachesForPosts(postId),
  ]);
  return imageIds;
}

const IDEMPOTENCY_TTL_SECONDS = 60 * 60;
/** How long a created post is recognised when an attempt to create it is repeated. */
const RETRY_WINDOW_SECONDS = 6 * 60 * 60;

const createdPostKey = (userId: number, clientKey: string) =>
  `post-batch:created:${userId}:${clientKey}` as RedisKeyTemplateSys;

/**
 * The posts in `posts` that an earlier attempt already created, by index. A call can outlive the
 * client's wait and still finish here, so a retry has to get those posts back rather than be
 * checked against them: at the same instant they fail the gap rule.
 *
 * - `clientKey` recognises a retry of the same attempt; it is recorded once a post is complete.
 * - The first image recognises a resubmit from the composer, which mints new keys. A row is
 *   adopted by one post, so finding it on a post made within the window means this post.
 */
async function findAlreadyCreated(
  posts: ScheduleBatchInput['posts'],
  user: SessionUser,
  now: Date
): Promise<Map<number, { postId: number; publishedAt: Date }>> {
  const found = new Map<number, { postId: number; publishedAt: Date }>();

  const recorded = await Promise.all(
    posts.map((post) =>
      post.clientKey ? sysRedis.get(createdPostKey(user.id, post.clientKey)) : null
    )
  );
  const keyedIds = new Map<number, number>();
  recorded.forEach((value, index) => {
    const postId = Number(value);
    if (value && Number.isInteger(postId) && postId > 0) keyedIds.set(index, postId);
  });
  if (keyedIds.size) {
    const rows = await dbWrite.post.findMany({
      where: { id: { in: [...keyedIds.values()] }, userId: user.id, publishedAt: { not: null } },
      select: { id: true, publishedAt: true },
    });
    for (const [index, postId] of keyedIds) {
      const row = rows.find((r) => r.id === postId);
      if (row?.publishedAt) found.set(index, { postId, publishedAt: row.publishedAt });
    }
  }

  const unmatched = posts.flatMap((post, index) => (found.has(index) ? [] : [index]));
  if (!unmatched.length) return found;
  const firstIds = unmatched.map((index) => posts[index].images[0].imageId);
  const recent = await dbWrite.post.findMany({
    where: {
      userId: user.id,
      publishedAt: { not: null },
      createdAt: { gte: new Date(now.getTime() - RETRY_WINDOW_SECONDS * 1000) },
      images: { some: { id: { in: firstIds } } },
    },
    select: {
      id: true,
      publishedAt: true,
      images: { where: { id: { in: firstIds } }, select: { id: true } },
    },
  });
  for (const index of unmatched) {
    const imageId = posts[index].images[0].imageId;
    const match = recent.find((post) => post.images.some((image) => image.id === imageId));
    if (match?.publishedAt) found.set(index, { postId: match.id, publishedAt: match.publishedAt });
  }
  return found;
}

type AdoptedPost = { postIndex: number; postId: number; imageIds: number[] };

/**
 * Once per chunk, over every image of the posts it created: lists `modelVersionIds` through the
 * editor's manual-resource path (`addResourceToPostImage`: the version's visibility, the
 * per-image cap, a version the meta already detected skipped), then scans again any
 * already-scanned image whose resources adoption changed, since the scan's review rules read
 * them. Images whose meta says on-site generation cannot take manual resources and are left out
 * rather than failing the chunk.
 */
async function finishChunk({
  adopted,
  resourcesBefore,
  modelVersionIds,
  user,
}: {
  adopted: AdoptedPost[];
  resourcesBefore: Map<number, Set<number>>;
  modelVersionIds: number[];
  user: SessionUser;
}) {
  const imageIds = adopted.flatMap((post) => post.imageIds);
  const rows = await dbWrite.image.findMany({
    where: { id: { in: imageIds } },
    select: {
      id: true,
      url: true,
      type: true,
      width: true,
      height: true,
      meta: true,
      ingestion: true,
    },
  });
  if (modelVersionIds.length) {
    const eligible = rows.filter(canAddManualResources).map((image) => image.id);
    if (eligible.length)
      for (const modelVersionId of modelVersionIds)
        await addResourceToPostImage({ id: eligible, modelVersionId, user });
  }
  const resourcesAfter = await listImageResources(imageIds);
  const toRescan = rows.filter(
    (row) =>
      row.ingestion === ImageIngestionStatus.Scanned &&
      [...(resourcesAfter.get(row.id) ?? [])].some((id) => !resourcesBefore.get(row.id)?.has(id))
  );
  if (!toRescan.length) return;
  await dbWrite.image.updateMany({
    where: { id: { in: toRescan.map((row) => row.id) } },
    data: { ingestion: ImageIngestionStatus.Rescan },
  });
  enqueueImageIngestion({
    images: toRescan.map((row) => ({
      id: row.id,
      url: row.url,
      type: row.type,
      width: row.width,
      height: row.height,
      prompt: (row.meta as { prompt?: string } | null)?.prompt,
    })),
    name: 'post-batch-rescan',
    userId: user.id,
  });
}

/** Only a client error's text is the creator's business; anything else is logged and masked, as
 *  the tRPC error formatter would do. */
function failureMessage(error: unknown) {
  const status = error instanceof TRPCError ? getHTTPStatusCodeFromError(error) : 500;
  if (status >= 500) handleLogError(error as Error);
  return status < 500 && error instanceof TRPCError ? error.message : POST_FAILED_MESSAGE;
}

/**
 * Every post either exists complete and scheduled or does not exist. Not a transaction: adoption
 * and the publish path do their own I/O (resources, caches, tracking), so a failed post is
 * deleted instead, as `createPostWithImagesHandler` does, and its images go back to the draft.
 * The listed resources are attached once per chunk after its posts are scheduled; if that fails,
 * every post this call created is discarded the same way.
 */
async function runScheduleBatch({
  input,
  ctx,
  steps,
}: {
  input: ScheduleBatchInput;
  ctx: ProtectedContext;
  steps: BatchSteps;
}): Promise<ScheduleBatchResult> {
  const { user } = ctx;
  if (input.idempotencyKey) {
    const claimed = await sysRedis.set(
      `lock:post-batch:${user.id}:${input.idempotencyKey}` as RedisKeyTemplateSys,
      '1',
      { NX: true, EX: IDEMPOTENCY_TTL_SECONDS }
    );
    if (!claimed)
      throw throwConflictError('This batch was already submitted. Refresh your scheduled posts.');
  }
  const resourceIds = [...new Set(input.resourceIds)].filter((id) => id !== input.modelVersionId);
  const alreadyCreated = await timed(steps, 'lookupMs', () =>
    findAlreadyCreated(input.posts, user, new Date())
  );
  steps.alreadyCreated = alreadyCreated.size;
  const toCreate = input.posts.filter((_, index) => !alreadyCreated.has(index));
  if (toCreate.length)
    await timed(steps, 'validateMs', async () => {
      const validation = await validateBatchSchedule({
        input: { publishedAts: toCreate.map((post) => post.publishedAt) },
        user,
      });
      if (!validation.ok)
        throw throwBadRequestError(validation.issues.map((issue) => issue.message).join(' '));
      if (input.modelVersionId) await assertCanUseModelVersion(input.modelVersionId, user);
      for (const id of resourceIds) await assertCanViewModelVersion(id, user);
    });

  const resourcesBefore = await listImageResources(
    toCreate.flatMap((post) => post.images.map((image) => image.imageId))
  );
  const created: ScheduleBatchResult['created'] = [];
  const adopted: AdoptedPost[] = [];
  let failure: { failedAt: number; message: string } | undefined;
  for (const [postIndex, post] of input.posts.entries()) {
    const prior = alreadyCreated.get(postIndex);
    if (prior) {
      created.push({
        postId: prior.postId,
        publishedAt: prior.publishedAt.toISOString(),
        alreadyCreated: true,
      });
      continue;
    }
    let postId: number | undefined;
    try {
      const draft = await timed(steps, 'createPostMs', () =>
        createPostHandler({
          input: { modelVersionId: input.modelVersionId, title: post.title, tags: input.tags },
          ctx,
        })
      );
      postId = draft.id;

      const postIdToFill = postId;
      const imageIds = await timed(steps, 'adoptMs', () =>
        adoptBatchMedia({ images: post.images, postId: postIdToFill, user })
      );
      steps.images += imageIds.length;
      if (input.tools.length)
        await timed(steps, 'toolsMs', () =>
          addImageTools({
            data: imageIds.flatMap((imageId) => input.tools.map((toolId) => ({ imageId, toolId }))),
            user,
          })
        );
      if (input.techniques.length)
        await timed(steps, 'techniquesMs', () =>
          addImageTechniques({
            data: imageIds.flatMap((imageId) =>
              input.techniques.map((techniqueId) => ({ imageId, techniqueId }))
            ),
            user,
          })
        );

      const postIdToPublish = postId;
      await timed(steps, 'publishMs', () =>
        updatePostHandler({ input: { id: postIdToPublish, publishedAt: post.publishedAt }, ctx })
      );
      steps.created++;
      created.push({ postId, publishedAt: post.publishedAt.toISOString() });
      adopted.push({ postIndex, postId, imageIds });
      if (post.clientKey)
        await sysRedis
          .set(createdPostKey(user.id, post.clientKey), String(postId), {
            EX: RETRY_WINDOW_SECONDS,
          })
          .catch(handleLogError);
    } catch (error) {
      steps.failed = true;
      if (postId !== undefined) await discardFailedPost(postId).catch(handleLogError);
      failure = { failedAt: postIndex, message: failureMessage(error) };
      break;
    }
  }
  if (adopted.length)
    try {
      await timed(steps, 'resourcesMs', () =>
        finishChunk({ adopted, resourcesBefore, modelVersionIds: resourceIds, user })
      );
    } catch (error) {
      steps.failed = true;
      for (const post of adopted) await discardFailedPost(post.postId).catch(handleLogError);
      return {
        created: created.filter((entry) => entry.alreadyCreated),
        failedAt: adopted[0].postIndex,
        message: failureMessage(error),
      };
    }
  return failure ? { created, ...failure } : { created };
}

/**
 * Where one call's time went, so a slow call can be read step by step. Durations (ms) and counts
 * only: no URLs, titles, prompts or other user content.
 */
type BatchSteps = {
  posts: number;
  created: number;
  alreadyCreated: number;
  images: number;
  failed: boolean;
  lockWaitMs: number;
  lookupMs: number;
  validateMs: number;
  createPostMs: number;
  adoptMs: number;
  resourcesMs: number;
  toolsMs: number;
  techniquesMs: number;
  publishMs: number;
};
type TimedStep =
  | 'lookupMs'
  | 'validateMs'
  | 'createPostMs'
  | 'adoptMs'
  | 'resourcesMs'
  | 'toolsMs'
  | 'techniquesMs'
  | 'publishMs';

async function timed<T>(steps: BatchSteps, step: TimedStep, run: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    steps[step] += performance.now() - startedAt;
  }
}

/** Logged beside `trpc-procedure-slow` for the same call, at the same threshold. */
function logSlowBatchSteps(steps: BatchSteps, durationMs: number, userId: number) {
  if (!(durationMs >= trpcSlowLogThresholdMs())) return;
  const round = (ms: number) => Math.round(ms);
  logToAxiom({
    name: 'post-schedule-batch-steps',
    type: 'info',
    userId,
    durationMs: round(durationMs),
    posts: steps.posts,
    created: steps.created,
    alreadyCreated: steps.alreadyCreated,
    images: steps.images,
    failed: steps.failed,
    lockWaitMs: round(steps.lockWaitMs),
    lookupMs: round(steps.lookupMs),
    validateMs: round(steps.validateMs),
    createPostMs: round(steps.createPostMs),
    adoptMs: round(steps.adoptMs),
    resourcesMs: round(steps.resourcesMs),
    toolsMs: round(steps.toolsMs),
    techniquesMs: round(steps.techniquesMs),
    publishMs: round(steps.publishMs),
  }).catch(() => undefined);
}

export async function scheduleBatch(args: {
  input: ScheduleBatchInput;
  ctx: ProtectedContext;
}): Promise<ScheduleBatchResult> {
  const startedAt = performance.now();
  const steps: BatchSteps = {
    posts: args.input.posts.length,
    created: 0,
    alreadyCreated: 0,
    images: 0,
    failed: false,
    lockWaitMs: 0,
    lookupMs: 0,
    validateMs: 0,
    createPostMs: 0,
    adoptMs: 0,
    resourcesMs: 0,
    toolsMs: 0,
    techniquesMs: 0,
    publishMs: 0,
  };
  try {
    return await withPostScheduleLock(args.ctx.user.id, () => {
      steps.lockWaitMs = performance.now() - startedAt;
      return runScheduleBatch({ ...args, steps });
    });
  } catch (error) {
    steps.failed = true;
    throw error;
  } finally {
    logSlowBatchSteps(steps, performance.now() - startedAt, args.ctx.user.id);
  }
}
