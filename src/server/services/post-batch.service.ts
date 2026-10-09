import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import {
  validateBatchSchedule as validateBatchScheduleDates,
  type ScheduleIssue,
  type SchedulePerDay,
} from '@civitai/shared/post-scheduling';
import { createPostHandler, updatePostHandler } from '~/server/controllers/post.controller';
import type { ProtectedContext } from '~/server/createContext';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { withPostScheduleLock } from '~/server/services/post-schedule-lock';
import { ModelStatus } from '~/shared/utils/prisma/enums';
import { sysRedis, type RedisKeyTemplateSys } from '~/server/redis/client';
import { getDailyPostLimit } from '~/server/schema/post.schema';
import type { ScheduleBatchInput, ValidateBatchScheduleInput } from '~/server/schema/post.schema';
import {
  addImageTechniques,
  addImageTools,
  queueImageSearchIndexUpdate,
} from '~/server/services/image.service';
import {
  canViewModelVersion,
  MODEL_VERSION_NOT_FOUND,
  modelVersionVisibilitySelect,
} from '~/server/services/model-version-visibility.service';
import { addPostImage } from '~/server/services/post.service';
import {
  handleLogError,
  throwBadRequestError,
  throwConflictError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import type { SessionUser } from '~/types/session';

export type BatchScheduleValidationResult = {
  ok: boolean;
  issues: ScheduleIssue[];
  dailyLimit: number;
  perDay: SchedulePerDay[];
};

export type ScheduleBatchResult = {
  created: { postId: number; publishedAt: string }[];
  /** Index into `posts` of the one that failed; it was deleted, the ones before it stay. */
  failedAt?: number;
  message?: string;
};

const POST_FAILED_MESSAGE = 'Something went wrong while creating this post. Try again.';

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

async function assertCanUseModelVersion(modelVersionId: number, user: SessionUser) {
  const version = await dbWrite.modelVersion.findUnique({
    where: { id: modelVersionId },
    select: modelVersionVisibilitySelect,
  });
  if (!version || !(await canViewModelVersion(version, user)))
    throw throwNotFoundError(MODEL_VERSION_NOT_FOUND);
  // Publishing or rescheduling a version moves every pending post on it to the release instant,
  // which would collapse a spread-out batch past the gap and the cap.
  if (version.status !== ModelStatus.Published)
    throw throwBadRequestError('Publish this version before promoting it with a batch.');
}

/** Drops a half-made post and its image rows but keeps the uploaded files: the creator retries
 *  with the same upload keys, which `deletePost` would have removed from storage. */
async function discardFailedPost(postId: number) {
  const images = await dbWrite.image.findMany({ where: { postId }, select: { id: true } });
  await dbWrite.image.deleteMany({ where: { postId } });
  if (images.length)
    await queueImageSearchIndexUpdate({
      ids: images.map((image) => image.id),
      action: SearchIndexUpdateQueueAction.Delete,
    });
  await dbWrite.post.delete({ where: { id: postId } });
}

/**
 * Every post either exists complete and scheduled or does not exist. Not a transaction:
 * `addPostImage` and the publish path do their own I/O (ingestion, caches, tracking), so a failed
 * post is deleted instead, as `createPostWithImagesHandler` does.
 */
const IDEMPOTENCY_TTL_SECONDS = 60 * 60;

async function runScheduleBatch({
  input,
  ctx,
}: {
  input: ScheduleBatchInput;
  ctx: ProtectedContext;
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
  const validation = await validateBatchSchedule({
    input: { publishedAts: input.posts.map((post) => post.publishedAt) },
    user,
  });
  if (!validation.ok)
    throw throwBadRequestError(validation.issues.map((issue) => issue.message).join(' '));
  if (input.modelVersionId) await assertCanUseModelVersion(input.modelVersionId, user);

  const created: ScheduleBatchResult['created'] = [];
  for (const [postIndex, post] of input.posts.entries()) {
    let postId: number | undefined;
    try {
      const draft = await createPostHandler({
        input: { modelVersionId: input.modelVersionId, title: post.title, tags: input.tags },
        ctx,
      });
      postId = draft.id;

      const imageIds: number[] = [];
      for (const [index, image] of post.images.entries()) {
        const attached = await addPostImage({ ...image, postId, index, user });
        imageIds.push(attached.id);
      }
      if (input.tools.length)
        await addImageTools({
          data: imageIds.flatMap((imageId) => input.tools.map((toolId) => ({ imageId, toolId }))),
          user,
        });
      if (input.techniques.length)
        await addImageTechniques({
          data: imageIds.flatMap((imageId) =>
            input.techniques.map((techniqueId) => ({ imageId, techniqueId }))
          ),
          user,
        });

      await updatePostHandler({ input: { id: postId, publishedAt: post.publishedAt }, ctx });
      created.push({ postId, publishedAt: post.publishedAt.toISOString() });
    } catch (error) {
      if (postId !== undefined) await discardFailedPost(postId).catch(handleLogError);
      // Only a client error's text is the creator's business; anything else is logged with a
      // generic message, as the tRPC error formatter would do.
      const status = error instanceof TRPCError ? getHTTPStatusCodeFromError(error) : 500;
      if (status >= 500) handleLogError(error as Error);
      return {
        created,
        failedAt: postIndex,
        message: status < 500 && error instanceof TRPCError ? error.message : POST_FAILED_MESSAGE,
      };
    }
  }
  return { created };
}

export function scheduleBatch(args: {
  input: ScheduleBatchInput;
  ctx: ProtectedContext;
}): Promise<ScheduleBatchResult> {
  return withPostScheduleLock(args.ctx.user.id, () => runScheduleBatch(args));
}
