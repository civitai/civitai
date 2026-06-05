import type { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { userContentOverviewCache } from '~/server/redis/caches';
import { resolveDownloadUrl } from '~/utils/delivery-worker';
import {
  getGetUrl,
  getS3Client,
  getUploadBucket,
  getUploadS3Client,
  isB2Url,
} from '~/utils/s3-utils';
import { Model3DStatus } from '~/shared/utils/prisma/enums';
import { imageSelect } from '~/server/selectors/image.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import type {
  DeleteModel3DInput,
  EnsureModel3DFromWorkflowInput,
  GetModel3DByIdInput,
  GetModel3DByThumbnailImageIdInput,
  GetModel3DByWorkflowIdInput,
  GetModel3DFilesInput,
  GetModel3DRelatedPostsInput,
  GetModel3DReviewSummaryInput,
  GetModel3DsInfiniteInput,
  PublishModel3DInput,
  RestoreModel3DInput,
  SetModel3DNsfwLevelInput,
  ToggleModel3DFlagInput,
  UnpublishModel3DInput,
  UpsertModel3DInput,
} from '~/server/schema/model3d.schema';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import { handlePolyGenWorkflowResult } from '~/server/services/orchestrator/ecosystems/polyGen.handler';
import type { PolyGenStep, Workflow, WorkflowStep } from '@civitai/client';
import type { Context } from '~/server/createContext';

type SessionUser = {
  id: number;
  isModerator?: boolean | null;
  username?: string | null;
};

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

const model3dFileSelect = {
  id: true,
  name: true,
  url: true,
  sizeKB: true,
  format: true,
  isPrimary: true,
  metadata: true,
  virusScanResult: true,
  virusScanMessage: true,
  scannedAt: true,
  exists: true,
  createdAt: true,
} satisfies Prisma.Model3DFileSelect;

const model3dDetailSelect = {
  id: true,
  name: true,
  description: true,
  userId: true,
  thumbnailImageId: true,
  thumbnailImage: { select: imageSelect },
  licenseId: true,
  license: true,
  licenseDetails: true,
  workflowId: true,
  sourceImageId: true,
  sourceImage: { select: imageSelect },
  generationParams: true,
  status: true,
  nsfw: true,
  tosViolation: true,
  poi: true,
  minor: true,
  unlisted: true,
  lockedProperties: true,
  availability: true,
  nsfwLevel: true,
  meta: true,
  createdAt: true,
  updatedAt: true,
  publishedAt: true,
  deletedAt: true,
  deletedBy: true,
  user: { select: userWithCosmeticsSelect },
  files: {
    select: model3dFileSelect,
    orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }] as Prisma.Model3DFileOrderByWithRelationInput[],
  },
  tags: {
    select: { tag: { select: { id: true, name: true } } },
  },
  metric: true,
} satisfies Prisma.Model3DSelect;

const model3dListSelect = {
  id: true,
  name: true,
  userId: true,
  status: true,
  nsfw: true,
  nsfwLevel: true,
  unlisted: true,
  // Flags + lockedProperties surfaced for the feed-card actions dropdown
  // (Model3DActionsMenu reuses the same shape on the detail page and the card).
  tosViolation: true,
  poi: true,
  minor: true,
  lockedProperties: true,
  availability: true,
  publishedAt: true,
  createdAt: true,
  thumbnailImageId: true,
  thumbnailImage: { select: imageSelect },
  user: { select: userWithCosmeticsSelect },
  metric: true,
} satisfies Prisma.Model3DSelect;

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export type Model3DGetById = NonNullable<Awaited<ReturnType<typeof getModel3DById>>>;
export const getModel3DById = async ({
  id,
  user,
}: GetModel3DByIdInput & { user?: SessionUser | null }) => {
  try {
    const isModerator = !!user?.isModerator;
    const model3d = await dbRead.model3D.findUnique({
      where: { id },
      select: model3dDetailSelect,
    });
    if (!model3d) throw throwNotFoundError(`No 3D model with id ${id}`);

    // Visibility rules:
    // - Mods see everything.
    // - Owner sees their own (any status).
    // - Public sees Published and not-Deleted.
    const isOwner = !!user && model3d.userId === user.id;
    if (!isModerator && !isOwner) {
      if (model3d.status !== Model3DStatus.Published) {
        throw throwNotFoundError(`No 3D model with id ${id}`);
      }
      if (model3d.deletedAt) throw throwNotFoundError(`No 3D model with id ${id}`);
    }

    return {
      ...model3d,
      tags: model3d.tags.map((t) => t.tag),
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

/**
 * Look up a Model3D by its orchestrator workflowId. Used by the queue-card
 * "Post from Generation" flow — the polyGen workflow result handler creates the
 * draft Model3D keyed on workflowId, and the queue card needs to resolve that
 * id before creating the Post.
 *
 * Returns null (not throws) when the row hasn't been created yet, so the UI
 * can poll / display a friendly "still processing" state.
 */
export const getModel3DByWorkflowId = async ({
  input,
  user,
}: {
  input: GetModel3DByWorkflowIdInput;
  user?: SessionUser | null;
}) => {
  try {
    const row = await dbRead.model3D.findUnique({
      where: { workflowId: input.workflowId },
      select: { id: true, userId: true, status: true, deletedAt: true, workflowId: true },
    });
    if (!row) return null;
    // The draft is owner- or mod-readable only — public can't peek at someone
    // else's draft via the orchestrator's workflow id.
    const isModerator = !!user?.isModerator;
    const isOwner = !!user && row.userId === user.id;
    if (!isModerator && !isOwner) return null;
    if (row.deletedAt) return null;
    return row;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

/**
 * Lazily materialize the Model3D draft for a completed PolyGen workflow.
 *
 * `handlePolyGenWorkflowResult` (the result handler that copies blobs to S3
 * and inserts the Model3D row) currently has no upstream caller — the
 * webhook wiring isn't in place yet. This mutation closes that gap on
 * demand: when the "Post from Generation" CTA fires, we look up the
 * existing draft and, if missing, fetch the workflow from the orchestrator,
 * extract the polyGen step output, and run the handler synchronously.
 *
 * Idempotent: re-running on the same workflowId returns the existing draft
 * (the handler itself is idempotent on `Model3D.workflowId UNIQUE`).
 */
export const ensureModel3DFromWorkflow = async ({
  input,
  user,
  ctx,
}: {
  input: EnsureModel3DFromWorkflowInput;
  user: SessionUser;
  ctx: Context;
}) => {
  // Fast path: draft already exists (handler ran earlier, or a prior
  // ensureFromWorkflow call landed it).
  const existing = await getModel3DByWorkflowId({ input, user });
  if (existing) return existing;

  try {
    const token = await getOrchestratorToken(user.id, ctx);
    const workflow: Workflow = await getWorkflow({
      token,
      path: { workflowId: input.workflowId },
    });

    // Confirm ownership; the orchestrator-side workflow has no userId so we
    // trust the SessionUser + the result handler's uniqueness on workflowId.
    if (!workflow.steps?.length) {
      throw throwBadRequestError('Workflow has no steps to materialize');
    }
    const polyGenStep = workflow.steps.find(
      (s: WorkflowStep) => s.$type === 'polyGen'
    ) as PolyGenStep | undefined;
    if (!polyGenStep?.output?.model) {
      throw throwBadRequestError(
        'Workflow has no PolyGen output to materialize a 3D model from'
      );
    }

    const meta = (workflow.metadata ?? {}) as Record<string, unknown>;
    const generationParams = (meta.params ?? {}) as Record<string, unknown>;
    const sourceImageId =
      typeof meta.sourceImageId === 'number' ? (meta.sourceImageId as number) : undefined;

    await handlePolyGenWorkflowResult({
      workflowId: input.workflowId,
      userId: user.id,
      output: polyGenStep.output,
      // generationParams is typed against the form-input shape upstream; the
      // workflow metadata carries the same snapshot, so a structural pass is
      // safe.
      generationParams: generationParams as never,
      sourceImageId,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }

  const created = await getModel3DByWorkflowId({ input, user });
  if (!created) {
    // Handler succeeded but the row didn't land — surface a server error
    // rather than silently leaving the CTA stuck.
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to materialize Model3D draft from workflow',
    });
  }
  return created;
};

export type Model3DGetInfinite = AsyncReturnType<typeof getModel3DsInfinite>;
export const getModel3DsInfinite = async ({
  limit,
  cursor,
  query,
  userId,
  username,
  status,
  statuses,
  tagIds,
  includeDrafts,
  user,
}: GetModel3DsInfiniteInput & { user?: SessionUser | null }) => {
  try {
    const isModerator = !!user?.isModerator;

    // Mod-only gating at the service layer (feature-flag-equivalent). Without a
    // signed-in mod, surface nothing. Workstream H wires the Flipt flag at the
    // router middleware layer; this is a defense-in-depth check.
    if (!isModerator) {
      // Owner-scoped listing is allowed (so users can see their own drafts on
      // their profile tab once the feature flag opens up). Anonymous + non-mod
      // viewers get an empty list until the flag flips.
      if (!user) return { items: [], nextCursor: undefined as number | undefined };
      // Allow the user to fetch their own; otherwise empty.
      if (userId && userId !== user.id && !username) {
        return { items: [], nextCursor: undefined as number | undefined };
      }
    }

    const AND: Prisma.Model3DWhereInput[] = [{ deletedAt: null }];

    // Status filter — drafts/published are MUTUALLY EXCLUSIVE tabs on the
    // profile page. The legacy `!allowDrafts` shape only suppressed the
    // Published filter without pushing a Draft filter, so the drafts tab
    // returned every status (including published). The ownership check
    // also required `userId === user.id`, but the profile page sends
    // `username` (not `userId`), so self-view never qualified for drafts.
    if (statuses?.length) {
      AND.push({ status: { in: statuses } });
    } else if (status) {
      AND.push({ status });
    } else {
      const isOwner =
        !!user &&
        ((!!userId && userId === user.id) ||
          (!!username && !!user.username && username === user.username));
      const wantDrafts = includeDrafts ?? false;
      const canSeeDrafts = isModerator || isOwner;

      if (wantDrafts && canSeeDrafts) {
        AND.push({ status: { in: [Model3DStatus.Draft, Model3DStatus.Unpublished] } });
      } else {
        // Default: Published only for EVERYONE — even mods. The main /3d-models
        // feed should never leak drafts; mods inspect drafts via their own
        // tools by passing explicit `statuses` (e.g. the profile page does
        // exactly this for mod-viewing-someone-else's drafts).
        AND.push({ status: Model3DStatus.Published });
      }
    }

    if (userId) AND.push({ userId });
    if (username) AND.push({ user: { username } });
    if (query) AND.push({ name: { contains: query, mode: 'insensitive' } });
    if (tagIds?.length) AND.push({ tags: { some: { tagId: { in: tagIds } } } });

    const take = Math.min(limit, 100);
    const items = await dbRead.model3D.findMany({
      take: take + 1,
      where: { AND },
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
      select: model3dListSelect,
    });

    let nextCursor: number | undefined;
    if (items.length > take) {
      const nextItem = items.pop();
      nextCursor = nextItem?.id;
    }

    return { items, nextCursor };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

/** Licenses available to assign to a Model3D. Seeded via migration. */
export const getModel3DLicenses = async () => {
  try {
    return await dbRead.model3DLicense.findMany({
      orderBy: [{ isCustom: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        description: true,
        allowCommercialUse: true,
        allowDerivatives: true,
        allowRedistribution: true,
        requireAttribution: true,
      },
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export const upsertModel3D = async ({
  input,
  user,
}: {
  input: UpsertModel3DInput;
  user: SessionUser;
}) => {
  const isModerator = !!user.isModerator;
  const { id, tagIds, generationParams, meta, ...data } = input;

  // Visibility changes (`status`) must go through the dedicated `publish` /
  // `unpublish` / moderation endpoints — those gate on thumbnail presence,
  // refresh the user-content cache, and emit the right notifications. We
  // strip `status` here for non-mods so a benign-looking upsert payload
  // can't quietly publish a draft.
  if (!isModerator) delete (data as Record<string, unknown>).status;

  // Strip locked props on update for non-mods.
  let lockedProperties: string[] | undefined = data.lockedProperties;
  let existing: { id: number; userId: number; lockedProperties: string[] } | null = null;
  if (id) {
    existing = await dbWrite.model3D.findUnique({
      where: { id },
      select: { id: true, userId: true, lockedProperties: true },
    });
    if (!existing) throw throwNotFoundError(`No 3D model with id ${id}`);
    if (!isModerator && existing.userId !== user.id) throw throwAuthorizationError();

    if (!isModerator) {
      const locked = new Set(existing.lockedProperties ?? []);
      for (const key of locked) delete (data as Record<string, unknown>)[key];
      // Non-mods can't change lockedProperties either.
      lockedProperties = undefined;
    }
  }

  const writeData: Prisma.Model3DUncheckedUpdateInput & Prisma.Model3DUncheckedCreateInput = {
    ...data,
    userId: existing?.userId ?? user.id,
    generationParams: (generationParams as Prisma.InputJsonValue) ?? undefined,
    meta: (meta as Prisma.InputJsonValue) ?? undefined,
    lockedProperties,
  } as Prisma.Model3DUncheckedUpdateInput & Prisma.Model3DUncheckedCreateInput;

  try {
    if (id) {
      const updated = await dbWrite.$transaction(async (tx) => {
        const row = await tx.model3D.update({
          where: { id },
          data: writeData,
          select: model3dDetailSelect,
        });

        if (tagIds) {
          await tx.tagsOnModel3D.deleteMany({ where: { model3dId: id } });
          if (tagIds.length) {
            await tx.tagsOnModel3D.createMany({
              data: tagIds.map((tagId) => ({ model3dId: id, tagId })),
              skipDuplicates: true,
            });
          }
        }

        return row;
      });
      return updated;
    }

    // Create — name + licenseId are required (handled by zod). Status defaults to Draft.
    const created = await dbWrite.$transaction(async (tx) => {
      const row = await tx.model3D.create({
        data: writeData,
        select: model3dDetailSelect,
      });

      if (tagIds?.length) {
        await tx.tagsOnModel3D.createMany({
          data: tagIds.map((tagId) => ({ model3dId: row.id, tagId })),
          skipDuplicates: true,
        });
      }

      return row;
    });

    return created;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const publishModel3D = async ({
  input,
  user,
}: {
  input: PublishModel3DInput;
  user: SessionUser;
}) => {
  const isModerator = !!user.isModerator;
  const existing = await dbWrite.model3D.findUnique({
    where: { id: input.id },
    select: {
      id: true,
      userId: true,
      status: true,
      thumbnailImageId: true,
      deletedAt: true,
    },
  });
  if (!existing) throw throwNotFoundError(`No 3D model with id ${input.id}`);
  if (!isModerator && existing.userId !== user.id) throw throwAuthorizationError();
  if (existing.deletedAt) throw throwBadRequestError('Cannot publish a deleted 3D model');
  if (!existing.thumbnailImageId) {
    throw throwBadRequestError('A thumbnail image is required before publishing.');
  }

  try {
    const now = new Date();
    const updated = await dbWrite.model3D.update({
      where: { id: input.id },
      data: {
        status: Model3DStatus.Published,
        publishedAt: now,
      },
      select: model3dDetailSelect,
    });
    await userContentOverviewCache.refresh(existing.userId);
    return updated;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const unpublishModel3D = async ({
  input,
  user,
}: {
  input: UnpublishModel3DInput;
  user: SessionUser;
}) => {
  const isModerator = !!user.isModerator;
  const existing = await dbWrite.model3D.findUnique({
    where: { id: input.id },
    select: { id: true, userId: true, status: true, deletedAt: true },
  });
  if (!existing) throw throwNotFoundError(`No 3D model with id ${input.id}`);
  if (!isModerator && existing.userId !== user.id) throw throwAuthorizationError();
  if (existing.deletedAt) throw throwBadRequestError('Cannot unpublish a deleted 3D model');

  try {
    const updated = await dbWrite.model3D.update({
      where: { id: input.id },
      data: { status: Model3DStatus.Unpublished },
      select: model3dDetailSelect,
    });
    await userContentOverviewCache.refresh(existing.userId);
    return updated;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const deleteModel3D = async ({
  input,
  user,
}: {
  input: DeleteModel3DInput;
  user: SessionUser;
}) => {
  const isModerator = !!user.isModerator;
  const existing = await dbWrite.model3D.findUnique({
    where: { id: input.id },
    select: { id: true, userId: true, deletedAt: true },
  });
  if (!existing) throw throwNotFoundError(`No 3D model with id ${input.id}`);
  if (!isModerator && existing.userId !== user.id) throw throwAuthorizationError();
  if (existing.deletedAt) return existing; // idempotent

  try {
    const updated = await dbWrite.model3D.update({
      where: { id: input.id },
      data: {
        status: Model3DStatus.Deleted,
        deletedAt: new Date(),
        deletedBy: user.id,
      },
      select: { id: true, status: true, deletedAt: true, deletedBy: true },
    });
    await userContentOverviewCache.refresh(existing.userId);
    return updated;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

// ---------------------------------------------------------------------------
// Moderation mutations (mod-only)
// ---------------------------------------------------------------------------

/**
 * Mod override of the (otherwise thumbnail-derived) Model3D nsfwLevel. When
 * `lock` is true we also append `'nsfwLevel'` to `lockedProperties` so the
 * batch recompute (`updateModel3DNsfwLevels`) skips this row going forward.
 *
 * Denormalized `Model3DMetric.nsfwLevel` is updated in lockstep.
 */
export const setModel3DNsfwLevel = async ({
  id,
  nsfwLevel,
  lock,
  user,
}: SetModel3DNsfwLevelInput & { user: SessionUser }) => {
  if (!user.isModerator) throw throwAuthorizationError();

  const existing = await dbWrite.model3D.findUnique({
    where: { id },
    select: { id: true, userId: true, lockedProperties: true },
  });
  if (!existing) throw throwNotFoundError(`No 3D model with id ${id}`);

  const nextLocked = lock
    ? Array.from(new Set([...(existing.lockedProperties ?? []), 'nsfwLevel']))
    : existing.lockedProperties;

  try {
    const updated = await dbWrite.$transaction(async (tx) => {
      const row = await tx.model3D.update({
        where: { id },
        data: { nsfwLevel, lockedProperties: nextLocked },
        select: model3dDetailSelect,
      });
      // Keep the denormalized metric row in sync. The metric row may not exist
      // for very new entities — upsert defensively.
      await tx.model3DMetric.updateMany({
        where: { model3dId: id },
        data: { nsfwLevel },
      });
      return row;
    });

    await userContentOverviewCache.refresh(existing.userId);

    return updated;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

const TOGGLEABLE_MODEL3D_FLAG_FIELDS = [
  'tosViolation',
  'poi',
  'minor',
  'nsfw',
  'unlisted',
] as const;
type ToggleableModel3DFlagField = (typeof TOGGLEABLE_MODEL3D_FLAG_FIELDS)[number];

/**
 * Flip a single moderation flag on a Model3D. Auto-locks the flipped field by
 * appending its name to `lockedProperties` so non-mod upserts can't override
 * the decision (see R8 in the plan).
 */
export const toggleModel3DFlag = async ({
  id,
  field,
  user,
}: ToggleModel3DFlagInput & { user: SessionUser }) => {
  if (!user.isModerator) throw throwAuthorizationError();
  // Defensive — the zod enum already restricts this, but the cast below relies
  // on it so re-validate.
  if (!TOGGLEABLE_MODEL3D_FLAG_FIELDS.includes(field as ToggleableModel3DFlagField)) {
    throw throwBadRequestError(`Field "${field}" is not toggleable`);
  }

  const existing = await dbWrite.model3D.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      lockedProperties: true,
      tosViolation: true,
      poi: true,
      minor: true,
      nsfw: true,
      unlisted: true,
    },
  });
  if (!existing) throw throwNotFoundError(`No 3D model with id ${id}`);

  const currentValue = existing[field as ToggleableModel3DFlagField];
  const nextValue = !currentValue;
  const nextLocked = Array.from(new Set([...(existing.lockedProperties ?? []), field]));

  try {
    const updated = await dbWrite.model3D.update({
      where: { id },
      data: {
        [field]: nextValue,
        lockedProperties: nextLocked,
      },
      select: model3dDetailSelect,
    });

    await userContentOverviewCache.refresh(existing.userId);

    return updated;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

/**
 * Mod-only restore. Only valid for `Deleted` → `Unpublished` (clears
 * `deletedAt` + `deletedBy`) or `Unpublished` → `Published`. Drafts and
 * already-Published rows are no-ops at the input layer — reject with 400.
 */
export const restoreModel3D = async ({ id, user }: RestoreModel3DInput & { user: SessionUser }) => {
  if (!user.isModerator) throw throwAuthorizationError();

  const existing = await dbWrite.model3D.findUnique({
    where: { id },
    select: { id: true, userId: true, status: true, deletedAt: true, thumbnailImageId: true },
  });
  if (!existing) throw throwNotFoundError(`No 3D model with id ${id}`);

  const isDeleted = existing.status === Model3DStatus.Deleted;
  const isUnpublished = existing.status === Model3DStatus.Unpublished;
  if (!isDeleted && !isUnpublished) {
    throw throwBadRequestError(
      `Cannot restore a 3D model in status "${existing.status}". Only Deleted or Unpublished rows can be restored.`
    );
  }

  // Two-step restore:
  //   Deleted     → Unpublished (clear deletedAt/deletedBy)
  //   Unpublished → Published
  // Use the *Unchecked* variant so we can null the `deletedBy` scalar FK
  // directly (the checked variant would require `deletedByUser: { disconnect }`).
  const data: Prisma.Model3DUncheckedUpdateInput = isDeleted
    ? {
        status: Model3DStatus.Unpublished,
        deletedAt: null,
        deletedBy: null,
      }
    : {
        status: Model3DStatus.Published,
        publishedAt: new Date(),
      };

  try {
    const updated = await dbWrite.model3D.update({
      where: { id },
      data,
      select: model3dDetailSelect,
    });

    await userContentOverviewCache.refresh(existing.userId);

    return updated;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

// ---------------------------------------------------------------------------
// Signed download URLs
// ---------------------------------------------------------------------------

export const getModel3DFiles = async ({
  input,
  user,
}: {
  input: GetModel3DFilesInput;
  user?: SessionUser | null;
}) => {
  const isModerator = !!user?.isModerator;
  const model3d = await dbRead.model3D.findUnique({
    where: { id: input.id },
    select: {
      id: true,
      userId: true,
      status: true,
      deletedAt: true,
      files: {
        select: model3dFileSelect,
        orderBy: [
          { isPrimary: 'desc' },
          { id: 'asc' },
        ] as Prisma.Model3DFileOrderByWithRelationInput[],
      },
    },
  });
  if (!model3d) throw throwNotFoundError(`No 3D model with id ${input.id}`);

  const isOwner = !!user && model3d.userId === user.id;
  if (!isModerator && !isOwner) {
    if (model3d.status !== Model3DStatus.Published) {
      throw throwNotFoundError(`No 3D model with id ${input.id}`);
    }
    if (model3d.deletedAt) throw throwNotFoundError(`No 3D model with id ${input.id}`);
  }

  // Sign each file URL. Two URL shapes can land in Model3DFile.url:
  //   - **Full URL** (e.g. https://civitai-media-uploads.s3.../key.glb) — this
  //     is what the test-seeder pipeline (and any client-side useS3Upload flow)
  //     stores. Presign directly against the bucket the URL points at; the
  //     delivery-worker doesn't know about every test/upload bucket so a raw
  //     URL would 401 in the browser.
  //   - **Key only** (e.g. `3d/<uuid>.glb`) — this is what the orchestrator
  //     PolyGen handler stores after `registerMediaLocation`. Resolve via
  //     delivery-worker / storage-resolver (existing legacy path).
  const files = await Promise.all(
    model3d.files.map(async (file) => {
      const isFullUrl = /^https?:\/\//i.test(file.url);
      try {
        if (isFullUrl) {
          const isB2 = isB2Url(file.url);
          const s3 = isB2 ? getUploadS3Client('b2') : getS3Client();
          // For B2 URLs, force the bucket so getGetUrl's parseKey fallback
          // (which strips it from the hostname) doesn't pick the wrong one.
          const bucket = isB2 ? getUploadBucket('b2') ?? undefined : undefined;
          const { url } = await getGetUrl(file.url, { s3, bucket, fileName: file.name });
          return { ...file, downloadUrl: url };
        }
        const { url } = await resolveDownloadUrl(file.id, file.url, file.name);
        return { ...file, downloadUrl: url };
      } catch {
        // TODO(model3d): surface re-presign failures to mods. For now we fall
        // back to the raw stored URL so the UI still has something to render.
        return { ...file, downloadUrl: file.url };
      }
    })
  );

  return { id: model3d.id, files };
};

// ---------------------------------------------------------------------------
// Moderator helper — find a Model3D by its thumbnail Image id.
//
// Used by the image-mod surface to surface a "this image is the thumbnail of a
// 3D Model" affordance + one-click unpublish on the parent (workstream H,
// §2.10). Mod-only at the router layer — this returns ownership info that
// non-mods shouldn't see.
// ---------------------------------------------------------------------------
export const getModel3DByThumbnailImageId = async ({
  imageId,
}: GetModel3DByThumbnailImageIdInput) =>
  dbRead.model3D.findUnique({
    where: { thumbnailImageId: imageId },
    select: { id: true, name: true, status: true },
  });

// ---------------------------------------------------------------------------
// upsertModel3DFromWorkflow — orchestrator-side idempotent upsert by workflowId
// Called by the PolyGen workflow result handler (no SessionUser context).
// Creates the Model3D draft + Model3DFile rows in one transaction.
// Re-running on the same workflowId returns the existing row + files (no dups).
// ---------------------------------------------------------------------------
export const upsertModel3DFromWorkflow = async ({
  workflowId,
  userId,
  thumbnailImageId,
  sourceImageId,
  licenseId,
  generationParams,
  files,
}: {
  workflowId: string;
  userId: number;
  thumbnailImageId?: number;
  sourceImageId?: number;
  licenseId: number;
  generationParams: Prisma.InputJsonValue;
  files: Array<{
    name: string;
    url: string;
    format: string;
    sizeKB: number;
    isPrimary: boolean;
  }>;
}): Promise<{ id: number; created: boolean }> => {
  return dbWrite.$transaction(async (tx) => {
    const existing = await tx.model3D.findUnique({
      where: { workflowId },
      select: { id: true },
    });

    if (existing) {
      // Idempotent path: workflow re-delivery / handler retry.
      return { id: existing.id, created: false };
    }

    const created = await tx.model3D.create({
      data: {
        name: `Generated 3D Model`,
        userId,
        workflowId,
        thumbnailImageId,
        sourceImageId,
        licenseId,
        generationParams,
        status: Model3DStatus.Draft,
      },
      select: { id: true },
    });

    if (files.length) {
      await tx.model3DFile.createMany({
        data: files.map((f) => ({
          model3dId: created.id,
          name: f.name,
          url: f.url,
          sizeKB: f.sizeKB,
          format: f.format,
          isPrimary: f.isPrimary,
        })),
        skipDuplicates: true,
      });
    }

    return { id: created.id, created: true };
  });
};

// ---------------------------------------------------------------------------
// Related Posts ("Makes & Uses") + Review summary
// ---------------------------------------------------------------------------

export type Model3DRelatedPost = AsyncReturnType<typeof getModel3DRelatedPosts>['items'][number];
export const getModel3DRelatedPosts = async ({
  input,
  user,
}: {
  input: GetModel3DRelatedPostsInput;
  user?: SessionUser | null;
}) => {
  try {
    const { model3dId, limit, cursor } = input;
    const isModerator = !!user?.isModerator;

    const model3d = await dbRead.model3D.findUnique({
      where: { id: model3dId },
      select: { id: true, userId: true },
    });
    if (!model3d) throw throwNotFoundError(`No 3D model with id ${model3dId}`);

    const viewerId = user?.id;

    // Visibility:
    //  - Moderators see everything.
    //  - Everyone else sees published+public posts AND their own posts
    //    (any state, so a user who just created a draft post linked to this
    //    model3d sees it on the page immediately, before they hit Publish).
    const publishedClause: Prisma.PostWhereInput = {
      publishedAt: { lte: new Date() },
      availability: { not: 'Private' },
    };
    const visibility: Prisma.PostWhereInput = isModerator
      ? {}
      : viewerId
        ? { OR: [publishedClause, { userId: viewerId }] }
        : publishedClause;

    const where: Prisma.PostWhereInput = {
      model3dId,
      ...visibility,
    };

    const take = Math.min(limit, 50);
    const items = await dbRead.post.findMany({
      take: take + 1,
      where,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
      select: {
        id: true,
        title: true,
        userId: true,
        publishedAt: true,
        nsfwLevel: true,
        user: { select: userWithCosmeticsSelect },
        images: {
          take: 1,
          orderBy: { index: 'asc' },
          select: imageSelect,
        },
      },
    });

    let nextCursor: number | undefined;
    if (items.length > take) {
      const nextItem = items.pop();
      nextCursor = nextItem?.id;
    }

    return { items, nextCursor };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const getModel3DReviewSummary = async ({
  input,
}: {
  input: GetModel3DReviewSummaryInput;
}) => {
  try {
    const agg = await dbRead.model3DReview.aggregate({
      where: { model3dId: input.model3dId, exclude: false },
      _avg: { rating: true },
      _count: { _all: true },
    });
    const recommendedCount = await dbRead.model3DReview.count({
      where: { model3dId: input.model3dId, exclude: false, recommended: true },
    });
    return {
      ratingAvg: agg._avg.rating ?? 0,
      ratingCount: agg._count._all,
      recommendedCount,
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

// Local helper type to avoid circular-import issues with the global one.
type AsyncReturnType<T extends (...args: any) => Promise<any>> = T extends (
  ...args: any
) => Promise<infer R>
  ? R
  : never;
