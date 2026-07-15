import { Prisma } from '@prisma/client';
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
import {
  EntityType,
  JobQueueType,
  MetricTimeframe,
  Model3DStatus,
  TagTarget,
} from '~/shared/utils/prisma/enums';
import { enqueueJobs } from '~/server/services/job-queue.service';
import {
  parseBitwiseBrowsingLevel,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { canViewModel3d } from '~/server/services/model3d.visibility';
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
  GetModel3DByPostIdInput,
  GetModel3DByThumbnailImageIdInput,
  GetModel3DByWorkflowIdInput,
  GetModel3DFilesInput,
  GetModel3DRelatedPostsInput,
  GetModel3DReviewSummaryInput,
  GetModel3DsInfiniteInput,
  GetModel3DTagsInput,
  Model3DGallerySettingsSchema,
  PublishModel3DInput,
  RestoreModel3DInput,
  SetModel3DNsfwLevelInput,
  ToggleModel3DFlagInput,
  UnpublishModel3DInput,
  UpdateModel3DGallerySettingsInput,
  UpsertModel3DInput,
} from '~/server/schema/model3d.schema';
import { Model3DSort } from '~/server/schema/model3d.schema';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import { isMature, maxNsfwLevel } from '~/shared/constants/orchestrator.constants';
import { handlePolyGenWorkflowResult } from '~/server/services/orchestrator/ecosystems/polyGen.handler';
import type { ImageBlob, PolyGenStep, Workflow, WorkflowStep } from '@civitai/client';
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
  // Surfaced so the detail page / download dropdown can label a file's
  // semantic role (primary / rigged / animated / walking / running /
  // walking-armature / running-armature) — the format alone isn't
  // enough to distinguish, e.g., the base GLB from the rigged GLB.
  variant: true,
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
  // Tags drive client-side `useApplyHiddenPreferences` filtering on the feed.
  // The hook's `'model3d'` branch reads a flat number[] of tagIds, mirroring
  // the `'models'` branch (`models.tags = tagsOnModels.map(x => x.tagId)`).
  tags: { select: { tagId: true } },
} satisfies Prisma.Model3DSelect;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a `MetricTimeframe` to the JS Date marking the start of that window.
 * Returns `null` for AllTime (caller should skip the filter entirely).
 */
const periodStartDate = (period: MetricTimeframe): Date | null => {
  if (period === MetricTimeframe.AllTime) return null;
  const now = new Date();
  const d = new Date(now);
  switch (period) {
    case MetricTimeframe.Day:
      d.setDate(d.getDate() - 1);
      return d;
    case MetricTimeframe.Week:
      d.setDate(d.getDate() - 7);
      return d;
    case MetricTimeframe.Month:
      d.setMonth(d.getMonth() - 1);
      return d;
    case MetricTimeframe.Year:
      d.setFullYear(d.getFullYear() - 1);
      return d;
    default:
      return null;
  }
};

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

    // The signed-in user's own recommend (thumbs-up), so the detail page can
    // render the gold thumbs-up toggle in its correct state.
    const userReview = user
      ? await dbRead.model3DReview.findUnique({
          where: { model3dId_userId: { model3dId: id, userId: user.id } },
          select: { id: true, recommended: true },
        })
      : null;

    return {
      ...model3d,
      tags: model3d.tags.map((t) => t.tag),
      userReview,
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
    const polyGenStep = workflow.steps.find((s: WorkflowStep) => s.$type === 'polyGen') as
      | PolyGenStep
      | undefined;
    if (!polyGenStep?.output?.model) {
      throw throwBadRequestError('Workflow has no PolyGen output to materialize a 3D model from');
    }

    // The chained `model3DPreview` step (see polygen-graph.handler) renders the
    // centered 2D preview the user actually saw in the queue card. Prefer it as
    // the saved thumbnail over the polyGen auto-thumbnail. It's not in the
    // client's WorkflowStep union, so reach into its image output structurally.
    const previewStep = workflow.steps.find((s: WorkflowStep) => s.$type === 'model3DPreview') as
      | { output?: { images?: ImageBlob[] } }
      | undefined;
    const thumbnailOverride = previewStep?.output?.images?.find((img) => !!img?.url);

    // Same gate the generator UI applies: the mesh blob is never rated by the
    // orchestrator, so the effective rating comes from the preview renders /
    // auto-thumbnail. A mature result generated without mature-content billing
    // must be unlocked (yellow Buzz → allowMatureContent) before it can be
    // materialized into a postable draft.
    const effectiveNsfwLevel = maxNsfwLevel([
      polyGenStep.output.model.nsfwLevel,
      polyGenStep.output.thumbnail?.nsfwLevel,
      ...(previewStep?.output?.images ?? []).map((img) => img?.nsfwLevel),
    ]);
    if (workflow.allowMatureContent === false && isMature(effectiveNsfwLevel)) {
      throw throwBadRequestError(
        'This 3D model was rated mature. Unlock it with Yellow Buzz before posting.'
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
      thumbnailOverride,
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
  sort,
  period,
  animated,
  unrated,
  browsingLevel,
  user,
}: GetModel3DsInfiniteInput & { user?: SessionUser | null }) => {
  try {
    const isModerator = !!user?.isModerator;

    // Access to the feed is gated by the `model3dFeed` flag at the router /
    // page layer. Content visibility below is self-contained — the status
    // filter serves Published-only to non-owners, drafts are gated to
    // owner/mod, and unrated/nsfw rows are filtered for non-owners — so the
    // feed is safe to serve to anonymous + non-mod viewers (previously they
    // were short-circuited to an empty list, which hid the public feed).

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

    // PolyGen `enableAnimation` toggle. JSON path equality against the
    // form-input snapshot stored on `Model3D.generationParams`. The
    // standalone `rigged` filter is gone (rigging now follows animation
    // at submit time via `toMeshyPolyGenInput`), so we only key off
    // `enableAnimation`. Older records with `enableRigging: true,
    // enableAnimation: false` still exist but aren't filterable — they
    // surface only via the unfiltered feed / direct link.
    if (animated) {
      AND.push({ generationParams: { path: ['enableAnimation'], equals: true } });
    }

    // Browsing-level shield. `Model3D.nsfwLevel` is derived from the single
    // thumbnail Image (`updateModel3DNsfwLevels`), so the stored value is
    // always a single-bit NsfwLevel power-of-2 — we can use a plain `in`
    // against the bits unpacked from the requested browsing flag instead of
    // dropping to raw SQL for a bitwise AND (the Model feed has to bit_or
    // across versions, so it uses Meilisearch + raw SQL; we don't need that
    // here).
    //
    // Mirrors the Image feed shape (image.service.ts ~L1732):
    //   `(nsfwLevel & browsingLevel) != 0 AND nsfwLevel != 0`
    //
    // Two clauses, applied independently:
    //   1. Unrated gate: `nsfwLevel != 0` for everyone EXCEPT mods + owners
    //      of the scoped query (their own profile tab). This applies even
    //      when the browsing-level bitmask is 0 / unresolved — without this
    //      clause, a client briefly sending `browsingLevel=0` (e.g. before
    //      `useBrowsingLevelDebounced` resolves on first paint) would leak
    //      unrated items into the public feed.
    //   2. Browsing-level bitmask: the standard rating intersection.
    const isOwnerScoped =
      !!user &&
      ((!!userId && userId === user.id) ||
        (!!username && !!user.username && username === user.username));
    const canSeeUnrated = isModerator || isOwnerScoped;

    if (unrated && canSeeUnrated) {
      // Mod/owner "unrated" filter — surface only not-yet-rated rows so mods
      // can find + rate them. Bypasses the browsing-level filter entirely.
      AND.push({ nsfwLevel: 0 });
    } else {
      if (!canSeeUnrated) {
        AND.push({ nsfwLevel: { not: 0 } });
      }

      // `browsingLevel` is already clamped per-request by the `applyDomainFeature`
      // middleware on `publicProcedure` — SFW on the green domain, for everyone
      // including mods. Trust it (like the models feed does) and default to
      // SFW-public when it's absent/0, so a missing level can never fall back to
      // "all levels" and leak mature content into the feed.
      const effectiveBrowsingLevel = browsingLevel || publicBrowsingLevelsFlag;
      const allowedLevels = parseBitwiseBrowsingLevel(effectiveBrowsingLevel);
      if (allowedLevels.length > 0) {
        if (canSeeUnrated) {
          // Owners + mods may still see their unrated drafts (nsfwLevel = 0).
          AND.push({
            OR: [{ nsfwLevel: { in: allowedLevels } }, { nsfwLevel: 0 }],
          });
        } else {
          AND.push({ nsfwLevel: { in: allowedLevels } });
        }
      }
    }

    // Period filter — clamps the feed to rows published (or, for unpublished
    // owner views, created) inside the requested window. Mirrors the regular
    // models feed's "date posted" dropdown.
    if (period && period !== MetricTimeframe.AllTime) {
      const since = periodStartDate(period);
      if (since) {
        AND.push({
          OR: [{ publishedAt: { gte: since } }, { createdAt: { gte: since } }],
        });
      }
    }

    // Sort. Default (or `Newest`) keeps the existing publishedAt-desc behavior.
    // The metric-driven sorts orderBy the related Model3DMetric row; counts
    // are non-nullable Ints (Prisma default 0 backfill), so plain `'desc'`
    // — `{ sort, nulls }` is only valid on nullable scalars.
    const orderBy: Prisma.Model3DOrderByWithRelationInput[] = (() => {
      switch (sort) {
        case Model3DSort.MostDownloaded:
          return [{ metric: { downloadCount: 'desc' } }, { id: 'desc' }];
        case Model3DSort.MostLiked:
          // "Most Liked" = thumbs-up (recommend) count. `reactionCount` used to
          // back this but it was copied from the thumbnail image's reactions —
          // a metric nothing feeds — so it was effectively always 0.
          return [{ metric: { recommendedCount: 'desc' } }, { id: 'desc' }];
        case Model3DSort.Newest:
        default:
          return [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }];
      }
    })();

    const take = Math.min(limit, 100);
    const rows = await dbRead.model3D.findMany({
      take: take + 1,
      where: { AND },
      cursor: cursor ? { id: cursor } : undefined,
      orderBy,
      select: model3dListSelect,
    });

    let nextCursor: number | undefined;
    if (rows.length > take) {
      const nextItem = rows.pop();
      nextCursor = nextItem?.id;
    }

    // The signed-in user's own recommend (thumbs-up) per row, so the card can
    // render the gold thumbs-up in its toggled state. One indexed lookup keyed
    // on (userId, model3dId) rather than a per-row correlated sub-select.
    const rowIds = rows.map((r) => r.id);
    const userReviews =
      user && rowIds.length
        ? await dbRead.model3DReview.findMany({
            where: { userId: user.id, model3dId: { in: rowIds } },
            select: { id: true, model3dId: true, recommended: true },
          })
        : [];
    const reviewByModel = new Map(userReviews.map((r) => [r.model3dId, r]));

    // Flatten `tags: [{ tagId }]` → `tags: number[]` so the client-side
    // `useApplyHiddenPreferences` hook can apply tag-based filtering with
    // the same shape it uses for the `'models'` branch.
    const items = rows.map(({ tags, ...rest }) => {
      const review = reviewByModel.get(rest.id);
      return {
        ...rest,
        tags: tags.map((t) => t.tagId),
        userReview: review ? { id: review.id, recommended: review.recommended } : null,
      };
    });

    return { items, nextCursor };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

/**
 * Tags actually used by Model3Ds, ranked by usage count. Drives the chip row
 * above the /3d-models feed. Mirrors `tag.getAll` shape (id + name) but scoped
 * to the Model3D corpus so empty/irrelevant tags don't pollute the row.
 */
export const getModel3DTags = async ({ query, limit }: GetModel3DTagsInput) => {
  try {
    const rows = await dbRead.tagsOnModel3D.groupBy({
      by: ['tagId'],
      _count: { tagId: true },
      orderBy: { _count: { tagId: 'desc' } },
      take: Math.min(limit, 200),
    });
    if (!rows.length) return { items: [] as { id: number; name: string; count: number }[] };

    const tags = await dbRead.tag.findMany({
      where: {
        id: { in: rows.map((r) => r.tagId) },
        ...(query ? { name: { contains: query, mode: 'insensitive' as const } } : {}),
      },
      select: { id: true, name: true },
    });
    const countById = new Map(rows.map((r) => [r.tagId, r._count.tagId]));
    const items = tags
      .map((t) => ({ id: t.id, name: t.name, count: countById.get(t.id) ?? 0 }))
      .sort((a, b) => b.count - a.count);
    return { items };
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
  const { id, tagIds, tagNames, generationParams, meta, ...data } = input;

  // Resolve free-form tag names (creating any that don't exist yet under
  // TagTarget.Model3D) and merge with `tagIds`. Mirrors the article-form
  // tag flow so the edit page can ship a TagsInput with on-the-fly
  // tag creation. We dedupe per (lowercased) name + per id so a payload
  // mixing both sources yields a clean attach set.
  let resolvedTagIds: number[] | undefined = tagIds;
  if (tagNames?.length || tagIds) {
    const normalized = Array.from(
      new Set((tagNames ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean))
    );
    let nameIds: number[] = [];
    if (normalized.length) {
      const existingByName = await dbWrite.tag.findMany({
        where: { name: { in: normalized } },
        select: { id: true, name: true },
      });
      const found = new Set(existingByName.map((t) => t.name));
      const toCreate = normalized.filter((n) => !found.has(n));
      let createdRows: { id: number; name: string }[] = [];
      if (toCreate.length) {
        await dbWrite.tag.createMany({
          // `TagTarget.Model3D` isn't in the generated Prisma client until the
          // hackathon migration is applied to dev — cast keeps the type
          // checker quiet while runtime still receives the correct enum value.
          data: toCreate.map((name) => ({ name, target: ['Model3D'] as TagTarget[] })),
          skipDuplicates: true,
        });
        createdRows = await dbWrite.tag.findMany({
          where: { name: { in: toCreate } },
          select: { id: true, name: true },
        });
      }
      nameIds = [...existingByName, ...createdRows].map((t) => t.id);
    }
    resolvedTagIds = Array.from(new Set([...(tagIds ?? []), ...nameIds]));
  }

  // Existing tags (e.g. `pokemon`, originally created with target `['Image']`)
  // get reused by name above — but their `target` array stays unchanged, so
  // downstream queries that filter by `Tag.target && '{Model3D}'` (the
  // picker autocomplete, category-tag lookups, search-index target filters)
  // won't surface them on future Model3Ds. Append `Model3D` to the target
  // array for every tag we're about to attach. The WHERE clause skips rows
  // that already carry it so we don't grow the array forever on resaves.
  if (resolvedTagIds?.length) {
    await dbWrite.$executeRaw`
      UPDATE "Tag"
      SET "target" = "target" || ARRAY['Model3D']::"TagTarget"[]
      WHERE "id" = ANY(${resolvedTagIds}::int[])
        AND NOT ('Model3D' = ANY("target"));
    `;
  }

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

        if (resolvedTagIds !== undefined) {
          await tx.tagsOnModel3D.deleteMany({ where: { model3dId: id } });
          if (resolvedTagIds.length) {
            await tx.tagsOnModel3D.createMany({
              data: resolvedTagIds.map((tagId) => ({ model3dId: id, tagId })),
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

      if (resolvedTagIds?.length) {
        await tx.tagsOnModel3D.createMany({
          data: resolvedTagIds.map((tagId) => ({ model3dId: row.id, tagId })),
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
      name: true,
      thumbnailImageId: true,
      deletedAt: true,
    },
  });
  if (!existing) throw throwNotFoundError(`No 3D model with id ${input.id}`);
  if (!isModerator && existing.userId !== user.id) throw throwAuthorizationError();
  if (existing.deletedAt) throw throwBadRequestError('Cannot publish a deleted 3D model');
  // Drafts are materialized with a blank name (forces the user to name them);
  // publish is a separate mutation from the name-enforcing upsert, so guard the
  // name here too — otherwise a nameless draft could be published directly.
  if (!existing.name?.trim()) {
    throw throwBadRequestError('A name is required before publishing.');
  }
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

// Resolve a post's linked Model3D in one round-trip — used by the
// "Posted to 3D Model" chip on the image viewers and the post-create page.
// Returns the minimal card payload (id + name + thumbnail) or null when the
// post isn't linked OR the viewer can't see the Model3D. The chip silently
// hides on null instead of surfacing a 404. Inlined here rather than calling
// `getModel3DById` so this service takes primitives (userId/isModerator)
// instead of a full session user.
export const getModel3DByPostId = async ({
  postId,
  userId,
  isModerator = false,
}: GetModel3DByPostIdInput & { userId?: number; isModerator?: boolean }) => {
  const post = await dbRead.post.findUnique({
    where: { id: postId },
    select: {
      model3d: {
        select: {
          id: true,
          name: true,
          userId: true,
          status: true,
          deletedAt: true,
          thumbnailImage: { select: { id: true, url: true, name: true } },
        },
      },
    },
  });
  const model3d = post?.model3d;
  if (!model3d) return null;

  if (
    !canViewModel3d({
      status: model3d.status,
      deletedAt: model3d.deletedAt,
      ownerId: model3d.userId,
      userId,
      isModerator,
    })
  )
    return null;

  return {
    id: model3d.id,
    name: model3d.name,
    thumbnailImage: model3d.thumbnailImage,
  };
};

// Durable replacement for the ambient `model3d.getByPostId` chip call: resolve
// JUST the linked Model3D id for a post, applying the SAME visibility rule, so
// the image-detail payload (`image.get`) can carry `model3dId` and the chip
// renders from the prop without firing a per-image tRPC query. Returns the id
// when the viewer may see the Model3D, else null (no link / hidden draft /
// deleted) — never leaks a hidden model's existence as a clickable chip.
export const getVisibleModel3DIdForPost = async ({
  postId,
  userId,
  isModerator = false,
}: {
  postId: number;
  userId?: number;
  isModerator?: boolean;
}): Promise<number | null> => {
  const post = await dbRead.post.findUnique({
    where: { id: postId },
    select: {
      model3d: { select: { id: true, userId: true, status: true, deletedAt: true } },
    },
  });
  const model3d = post?.model3d;
  if (!model3d) return null;
  if (
    !canViewModel3d({
      status: model3d.status,
      deletedAt: model3d.deletedAt,
      ownerId: model3d.userId,
      userId,
      isModerator,
    })
  )
    return null;
  return model3d.id;
};

// Batched sibling of `getVisibleModel3DIdForPost` for the image FEED path.
// The feed payload (`getAllImages` / `getAllImagesIndex`) already carries a RAW
// `Post.model3dId` (selected from SQL or read from the Meili doc) that is NOT
// visibility-checked — a hidden Draft / deleted Model3D's id would otherwise
// leak to the client as a clickable chip. Most feed images aren't linked to a
// Model3D at all (model3dId is null), so callers pass ONLY the handful of
// non-null ids per page; this resolves them in ONE query (no per-image N+1) and
// returns the set the viewer may see. Applies the SAME `canViewModel3d`
// predicate as the single-post lookup, so a hidden model is nulled identically.
export const getVisibleModel3DIds = async ({
  model3dIds,
  userId,
  isModerator = false,
}: {
  model3dIds: number[];
  userId?: number;
  isModerator?: boolean;
}): Promise<Set<number>> => {
  const ids = [...new Set(model3dIds)];
  if (!ids.length) return new Set();
  const rows = await dbRead.model3D.findMany({
    where: { id: { in: ids } },
    select: { id: true, userId: true, status: true, deletedAt: true },
  });
  const visible = new Set<number>();
  for (const row of rows) {
    if (
      canViewModel3d({
        status: row.status,
        deletedAt: row.deletedAt,
        ownerId: row.userId,
        userId,
        isModerator,
      })
    )
      visible.add(row.id);
  }
  return visible;
};

// ---------------------------------------------------------------------------
// Per-Model3D gallery moderation. Mirrors `model.gallerySettings` minus
// `pinnedPosts` + `level` (no version dimension, no level override for v1).
// Read returns expanded `{hiddenUsers, hiddenTags, hiddenImages}` so the
// existing `useApplyHiddenPreferences` consumer doesn't need a separate
// shape for model3d.
// ---------------------------------------------------------------------------
export const getModel3DGallerySettings = async ({ id }: { id: number }) => {
  const row = await dbRead.model3D.findUnique({
    where: { id },
    select: { id: true, userId: true, gallerySettings: true },
  });
  if (!row) return null;
  const settings = (row.gallerySettings ?? {}) as Model3DGallerySettingsSchema;
  const { tags, users, images } = settings;
  const hiddenTags =
    tags && tags.length
      ? await dbRead.tag.findMany({
          where: { id: { in: tags } },
          select: { id: true, name: true },
        })
      : [];
  const hiddenUsers =
    users && users.length
      ? await dbRead.user.findMany({
          where: { id: { in: users } },
          select: { id: true, username: true },
        })
      : [];
  return {
    hiddenTags,
    hiddenUsers,
    hiddenImages: images ?? [],
  };
};

export const updateModel3DGallerySettings = async ({
  input,
  userId,
  isModerator = false,
}: {
  input: UpdateModel3DGallerySettingsInput;
  userId: number;
  isModerator?: boolean;
}) => {
  const row = await dbWrite.model3D.findUnique({
    where: { id: input.id },
    select: { id: true, userId: true },
  });
  if (!row) throw throwNotFoundError(`No 3D model with id ${input.id}`);
  if (row.userId !== userId && !isModerator) throw throwAuthorizationError();

  const next: Model3DGallerySettingsSchema | null = input.gallerySettings
    ? {
        users: input.gallerySettings.hiddenUsers.map((u) => u.id),
        tags: input.gallerySettings.hiddenTags.map((t) => t.id),
        images: input.gallerySettings.hiddenImages,
      }
    : null;

  await dbWrite.model3D.update({
    where: { id: input.id },
    data: {
      gallerySettings: (next as Prisma.InputJsonValue | null) ?? Prisma.JsonNull,
    },
  });

  return { id: input.id, gallerySettings: input.gallerySettings };
};

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
    /**
     * Variant discriminator — matches the column on Model3DFile. Omit
     * (or pass "primary") for the textured base mesh; the polygen
     * handler tags rigged / animated / walking / running variants here
     * so the `(model3dId, format, variant)` unique constraint can let
     * them coexist.
     */
    variant?: string;
  }>;
}): Promise<{ id: number; created: boolean }> => {
  const result = await dbWrite.$transaction(async (tx) => {
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
        // Intentionally blank so the edit page forces the user to name the
        // model rather than skipping past a pre-filled placeholder.
        name: '',
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
          variant: f.variant ?? 'primary',
        })),
        skipDuplicates: true,
      });
    }

    return { id: created.id, created: true };
  });

  // Explicitly enqueue the freshly-created Model3D for nsfwLevel rollup.
  // Belt-and-suspenders with the scan-webhook path: the webhook also
  // enqueues when the thumbnail Image finishes scanning, but that path
  // depends on the Image's scan completing AFTER this row is committed
  // (otherwise the webhook's `findMany` race-misses). Enqueueing here
  // guarantees the row enters the cron pipeline at least once regardless
  // of which side completes first. `ON CONFLICT DO NOTHING` in
  // `enqueueJobs` makes the eventual double-enqueue a no-op.
  if (result.created) {
    await enqueueJobs([
      {
        entityId: result.id,
        entityType: EntityType.Model3D,
        type: JobQueueType.UpdateNsfwLevel,
      },
    ]);
  }

  return result;
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
    // Pure thumbs system: clients compute % from `recommendedCount /
    // ratingCount`. The legacy `rating` 1-5 column was dropped in
    // migration `20260605120000_model3d_drop_legacy_rating`.
    const agg = await dbRead.model3DReview.aggregate({
      where: { model3dId: input.model3dId, exclude: false },
      _count: { _all: true },
    });
    const recommendedCount = await dbRead.model3DReview.count({
      where: { model3dId: input.model3dId, exclude: false, recommended: true },
    });
    return {
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
