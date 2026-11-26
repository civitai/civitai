import { assertNotDealFileImages } from '~/server/services/deal-file-image';
import { assertAccountNotRestricted } from '~/server/services/account-restriction.service';
import { z } from 'zod';
import type { SessionUser } from '~/types/session';
import { comicProjectMetaSchema, parseComicProjectMeta } from '~/server/schema/comics.schema';
import {
  router,
  protectedProcedure,
  guardedProcedure,
  publicProcedure,
  moderatorProcedure,
  middleware,
  isFlagProtected,
} from '~/server/trpc';
import { dbRead, dbWrite } from '~/server/db/client';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { fetchTimeoutSignal } from '~/server/utils/fetch-timeout';
import { regionProxyMiddleware } from '~/server/orchestrator/region-proxy.middleware';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import {
  chapterEarlyAccessCapMessage,
  chapterEarlyAccessLockedMessage,
  getMaxEarlyAccessDays,
  getMaxEarlyAccessModels,
} from '~/server/utils/early-access-helpers';
import { creatorScoreFromSession } from '~/shared/utils/creator-score';
import {
  Availability,
  ComicReferenceStatus,
  ComicChapterStatus,
  ComicEngagementType,
  ComicGenre,
  ComicPanelStatus,
  ComicProjectStatus,
  ComicReferenceType,
  ImageIngestionStatus,
} from '~/shared/utils/prisma/enums';
import { ownerMediaAllowed } from '~/server/common/image-block-marker';
import { actsAsModerator } from '~/server/utils/image-media-visibility';
import {
  blockLeavesMedia,
  coverBlockSelect,
  panelImageVisibilitySelect,
  withholdRestrictedPanelImages,
  withServableCover,
} from '~/server/services/comics/chapter-visibility';
import {
  getComicMetricRows,
  getPublicComicForReader,
  getPublicComicProjects,
  getPublicComicProjectsSchema,
  stripNsfwPanelImages,
} from '~/server/services/comics/public-comics.service';
import {
  imageNotRestrictedWhere,
  imageRestrictionSelect,
  isImageServable,
  ownerMediaAllowedWhere,
  type RestrictableImage,
} from '~/server/common/image-visibility';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { panelSourceImageUrl, viewerPanelMetadata } from '~/server/services/comics/panel-metadata';
import { pollIterationWorkflow } from '~/server/services/orchestrator/poll-iteration';
import { assertCanGenerate, getUserQueueStatus } from '~/server/services/orchestrator/queue-limits';
import { getWorkflow, updateWorkflow } from '~/server/services/orchestrator/workflows';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@prisma/client';
import {
  assertUnlockAllowed,
  assertUnlockReleasesOutput,
  formatGenerationResponse2,
} from '~/server/services/orchestrator/orchestration-new.service';
import { GenerationStatusRefusedError } from '~/server/services/generation/generation-kill-switch';
import {
  getPresetModelConfig,
  pickAspectRatioSize,
  PRESET_MODEL_CONFIG,
  assertPresetGenerationAllowed,
  submitPresetImageGen,
  whatIfPresetImageGen,
  type PresetModelConfig,
} from '~/server/services/orchestrator/preset-image-gen.service';
import { blockedReasonMessage, WorkflowData } from '~/shared/orchestrator/workflow-data';
import { colorDomainNames, type ColorDomain } from '~/shared/constants/domain.constants';
import { enhanceComicPrompt } from '~/server/services/comics/prompt-enhance';
import { orchestratorChatCompletionCost } from '~/server/services/comics/orchestrator-chat';
import { DEFAULT_CHAT_COMPLETION_MODEL } from '~/server/services/orchestrator/chatCompletion';
import { resolveReferenceMentions } from '~/server/services/comics/mention-resolver';
import { updateComicNsfwLevels } from '~/server/services/nsfwLevels.service';
import { markComicProjectsChapterPublished } from '~/server/services/comics/chapter-publish.service';
import {
  createImage,
  createImageResources,
  ingestImageById,
} from '~/server/services/image.service';
import { imageMetaSchema } from '~/server/schema/image.schema';
import { createNotification } from '~/server/services/notification.service';
import { planChapterPanels } from '~/server/services/comics/story-plan';
import { getEdgeUrl } from '~/client-utils/edge-url';
import {
  EntityAccessPermission,
  NotificationCategory,
  SearchIndexUpdateQueueAction,
  SignalMessages,
} from '~/server/common/enums';
import { signalClient } from '~/utils/signal-client';
import { comicsSearchIndex } from '~/server/search-index';
import {
  hasSafeBrowsingLevel,
  nsfwBrowsingLevelsFlag,
  orchestratorNsfwLevelMap,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { EARLY_ACCESS_CONFIG } from '~/server/common/constants';
import { hasEntityAccess } from '~/server/services/common.service';
import {
  createMultiAccountBuzzTransaction,
  refundMultiAccountTransaction,
} from '~/server/services/buzz.service';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { domainSpendType, getAllowedAccountTypes } from '~/server/utils/buzz-helpers';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getImageUploadBackend } from '~/utils/s3-utils';
import { registerMediaLocation } from '~/server/services/storage-resolver';
import {
  assertBareUploadKeys,
  COVER_IMAGE_UNAVAILABLE_MESSAGE,
  isBareUploadKey,
} from '~/server/services/image-url-ownership';
import { recordMintedUploadKey } from '~/server/services/image-upload-action.service';
import {
  assertGenerationInputsUsable,
  assertGenerationInputUrlsUsable,
  assertStoredImageUrlsUnblocked,
} from '~/server/services/generation-input-urls';
import { env } from '~/env/server';
import { randomUUID } from 'crypto';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// Feature flag gate — all procedures require the comicCreator flag

const comicFlag = isFlagProtected('comicCreator');
// Comic panel responses can surface raw orchestrator blob URLs (e.g.
// `blurredPreviewUrl` on a blocked panel), which RU ISPs DPI-block. Rewrite them
// to the Cloudflare-fronted proxy for RU requests. See ClickUp 868kdkv93.
const comicProtectedProcedure = protectedProcedure.use(comicFlag).use(regionProxyMiddleware);
// For writes that are ordinary user content rather than comic authoring: `guardedProcedure` adds the
// onboarding and MUTE checks every other comment surface has. Without it a muted account could comment
// on a chapter — the box is hidden client-side, which is presentation, not a gate.
const comicGuardedProcedure = guardedProcedure.use(comicFlag).use(regionProxyMiddleware);
// Generation and spend. The restriction is the stored standing rather than the session's, and
// without `guardedProcedure`'s onboarding and email gates, which comics has never required.
const comicGenerationProcedure = comicProtectedProcedure.use(async ({ ctx, next }) => {
  await assertAccountNotRestricted(ctx.user!.id, ctx.user!);
  return next();
});
const comicPublicProcedure = publicProcedure.use(comicFlag).use(regionProxyMiddleware);
const comicModeratorProcedure = moderatorProcedure.use(comicFlag);

// Comic panel generation runs on the shared preset image-gen service
// (`preset-image-gen.service.ts`), which owns the model registry, the
// generation-graph input builder, and the submit/what-if wrappers. The aliases
// and thin wrappers below keep the comics call sites reading naturally.
const COMIC_MODEL_CONFIG = PRESET_MODEL_CONFIG;

const DEFAULT_COMIC_MODEL = 'NanoBanana2';
const DEFAULT_ASPECT_RATIO = '3:4';

function getComicModelConfig(baseModel?: string | null) {
  return getPresetModelConfig(baseModel, DEFAULT_COMIC_MODEL);
}

function getAspectRatioDimensions(aspectRatio: string, modelConfig?: PresetModelConfig) {
  const sizes = modelConfig?.sizes ?? COMIC_MODEL_CONFIG[DEFAULT_COMIC_MODEL].sizes;
  return pickAspectRatioSize(aspectRatio, sizes);
}

/**
 * Single entry point for all comic image generation. Thin wrapper over the
 * shared `submitPresetImageGen` that fixes the comics workflow tags and resolves
 * currencies from the request's feature flags.
 *
 * `width`/`height` are accepted for call-site compatibility but unused — the
 * graph derives dimensions from the ecosystem's aspect-ratio options.
 */
async function submitComicGeneration({
  prompt,
  aspectRatio,
  quantity = 1,
  images,
  modelConfig,
  versionIdOverride,
  user,
  token,
  features,
  isGreen,
  allowMatureContent,
  track,
}: {
  prompt: string;
  width: number;
  height: number;
  aspectRatio: string;
  quantity?: number;
  images?: { url: string; width: number; height: number }[] | null;
  modelConfig: PresetModelConfig;
  versionIdOverride?: number;
  user: SessionUser;
  token: string;
  features: FeatureAccess;
  isGreen?: boolean;
  allowMatureContent?: boolean;
  track?: any; // Tracker class from createContext
}) {
  return submitPresetImageGen({
    prompt,
    aspectRatio,
    quantity,
    images,
    modelConfig,
    versionIdOverride,
    user,
    token,
    flags: features,
    currencies: getAllowedAccountTypes(features, ['blue']),
    tags: isGreen ? ['comics', 'green'] : ['comics'],
    isGreen,
    allowMatureContent,
    track,
  });
}

/**
 * Normalize an orchestrator-emitted nsfwLevel to the numeric `NsfwLevel`
 * bitfield. Orchestrator outputs sometimes carry the level as a string
 * ("pg", "pg13", "r"…); without this, downstream `isMature`/flag checks
 * silently coerce the string to NaN and treat mature candidates as safe.
 */
function normalizeCandidateNsfwLevel(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return orchestratorNsfwLevelMap[normalized];
  }
  return undefined;
}

/** Detect orchestrator/generator offline errors and return a user-friendly message. */
export function getOrchestratorErrorMessage(error: unknown): string {
  // The generation kill switch's refusal is the operator's own message: shown as written.
  if (error instanceof GenerationStatusRefusedError) return error.message;
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();

  if (
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('network') ||
    lower.includes('timeout') ||
    lower.includes('socket hang up') ||
    lower.includes('503') ||
    lower.includes('502') ||
    lower.includes('service unavailable')
  ) {
    return 'The image generator is currently offline or unreachable. Please try again in a few minutes.';
  }
  if (lower.includes('rate limit') || lower.includes('429')) {
    return 'The image generator is currently overloaded. Please wait a moment and try again.';
  }
  if (lower.includes('insufficient') || lower.includes('buzz')) {
    return 'Insufficient Buzz balance to generate this panel.';
  }
  return `Generation failed: ${msg}`;
}

/** Send a ComicPanelUpdate signal so the workspace page can update without polling. */
function sendComicPanelSignal(
  userId: number,
  data: {
    panelId: number;
    projectId: number;
    status: string;
    workflowId?: string | null;
    imageUrl?: string | null;
  }
) {
  signalClient.send({ userId, target: SignalMessages.ComicPanelUpdate, data }).catch(() => null); // Fire-and-forget
}

/**
 * Loads an existing image that `userId` may attach to their comic, or refuses with an
 * authorization error when it is missing or belongs to someone else. The one image-ownership
 * check for every comics route that points a row at an existing image by id.
 */
async function getOwnedImageOrThrow(imageId: number, userId: number) {
  const image = await dbRead.image.findUnique({
    where: { id: imageId },
    select: { id: true, userId: true, url: true, ingestion: true, blockedFor: true },
  });
  if (!image || image.userId !== userId) {
    throw throwAuthorizationError();
  }
  // Attached, a blocked image's media would reach its owner through the row it backs.
  if (!ownerMediaAllowed(image))
    throw throwBadRequestError('This image is blocked and cannot be used here.');
  await assertNotDealFileImages([imageId], 'used here');
  const { ingestion: _ingestion, blockedFor: _blockedFor, ...owned } = image;
  return owned;
}

// Middleware to check project ownership
const isProjectOwner = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { projectId } = input as { projectId?: number };
  if (projectId) {
    const project = await dbRead.comicProject.findUnique({
      where: { id: projectId },
      select: { userId: true },
    });
    if (!project || project.userId !== ctx.user.id) {
      throw throwAuthorizationError();
    }
  }

  return next({ ctx });
});

// Middleware to check chapter ownership (chapter -> project -> user)
const isChapterOwner = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { projectId, chapterPosition } = input as {
    projectId?: number;
    chapterPosition?: number;
  };
  if (projectId != null && chapterPosition != null) {
    const chapter = await dbRead.comicChapter.findUnique({
      where: { projectId_position: { projectId, position: chapterPosition } },
      include: { project: { select: { userId: true } } },
    });
    if (!chapter || chapter.project.userId !== ctx.user.id) {
      throw throwAuthorizationError();
    }
  }

  return next({ ctx });
});

// Schemas
const uploadKeySchema = z.string().refine(isBareUploadKey, COVER_IMAGE_UNAVAILABLE_MESSAGE);

const createProjectSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(5000).optional(),
  genre: z.nativeEnum(ComicGenre).optional(),
  coverUrl: uploadKeySchema.optional(),
  heroUrl: uploadKeySchema.optional(),
  heroImagePosition: z.number().int().min(0).max(100).optional(),
});

const getProjectSchema = z.object({
  id: z.number().int(),
});

const getChapterSchema = z.object({
  projectId: z.number().int(),
  // `position` defaults to 0 in the schema, so a negative value can never
  // match a real row. Reject it at the boundary so the client's `?? -1`
  // sentinel (used to disable the query) can never accidentally hit the DB.
  chapterPosition: z.number().int().nonnegative(),
});

// Reference (character/location/item) creation — optionally scoped to a project
const createReferenceSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((v) => !v.includes('@'), 'Name cannot contain @ character'),
  type: z.nativeEnum(ComicReferenceType).default(ComicReferenceType.Character),
  description: z.string().max(2000).optional(),
  projectId: z.number().int().optional(),
});

const addReferenceImagesSchema = z.object({
  referenceId: z.number().int(),
  images: z
    .array(
      z.object({
        url: uploadKeySchema,
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
    )
    .min(1)
    .max(10),
});

const comicModelEnum = z.enum([
  'NanoBanana2',
  'NanoBanana',
  'Flux2',
  'Seedream',
  'SeedreamLite',
  'OpenAI',
  'OpenAI2',
  'OpenAI25Flare',
  'OpenAI25Sunburst',
  'Qwen',
  'Grok',
]);

const createPanelSchema = z.object({
  projectId: z.number().int(),
  chapterPosition: z.number().int().min(0),
  referenceIds: z.array(z.number().int()).optional(),
  selectedImageIds: z.array(z.number().int()).optional(),
  prompt: z.string().min(1).max(2000),
  useContext: z.boolean().default(true),
  referencePanelId: z.number().int().optional(),
  // Appended to the site origin, so only a bundled layout image may be named.
  layoutImagePath: z
    .string()
    .regex(/^\/images\/comics\/layouts\/[a-z0-9-]+\.png$/)
    .optional(),
  position: z.number().int().min(0).optional(),
  aspectRatio: z.string().default('3:4'),
  baseModel: comicModelEnum.nullish(),
  quantity: z.number().int().min(1).max(4).default(1),
});

const updatePanelSchema = z.object({
  panelId: z.number().int(),
  status: z.literal(ComicPanelStatus.Generating).optional(),
  imageUrl: z.string().nullish(),
});

const deletePanelSchema = z.object({
  panelId: z.number().int(),
});

const reorderPanelsSchema = z.object({
  projectId: z.number().int(),
  chapterPosition: z.number().int().min(0),
  panelIds: z.array(z.number().int()),
});

// Chapter schemas
const createChapterSchema = z.object({
  projectId: z.number().int(),
  name: z.string().min(1).max(255).default('New Chapter'),
});

const updateChapterSchema = z.object({
  projectId: z.number().int(),
  chapterPosition: z.number().int().min(0),
  name: z.string().min(1).max(255),
});

const deleteChapterSchema = z.object({
  projectId: z.number().int(),
  chapterPosition: z.number().int().min(0),
});

const reorderChaptersSchema = z.object({
  projectId: z.number().int(),
  order: z.array(z.number().int()),
});

const duplicatePanelSchema = z.object({
  panelId: z.number().int(),
});

const duplicateChapterSchema = z.object({
  projectId: z.number().int(),
  chapterPosition: z.number().int().min(0),
});

const planChapterPanelsSchema = z.object({
  projectId: z.number().int(),
  storyDescription: z.string().min(1).max(5000),
  panelCount: z.number().int().min(2).max(20).nullish(),
});

const smartCreateChapterSchema = z.object({
  projectId: z.number().int(),
  chapterName: z.string().min(1).max(255).default('New Chapter'),
  referenceIds: z.array(z.number().int()).optional(),
  storyDescription: z.string().max(5000).default(''),
  panels: z
    .array(
      z.object({
        prompt: z.string().min(1).max(2000),
      })
    )
    .min(1)
    .max(20),
  aspectRatio: z.string().default('3:4'),
  baseModel: comicModelEnum.nullish(),
});

const enhancePanelSchema = z.object({
  projectId: z.number().int(),
  chapterPosition: z.number().int().min(0),
  referenceIds: z.array(z.number().int()).optional(),
  selectedImageIds: z.array(z.number().int()).optional(),
  sourceImageUrl: uploadKeySchema,
  sourceImageWidth: z.number().int().positive(),
  sourceImageHeight: z.number().int().positive(),
  prompt: z.string().max(2000).optional(),
  useContext: z.boolean().default(true),
  referencePanelId: z.number().int().optional(),
  position: z.number().int().min(0).optional(),
  aspectRatio: z.string().default('3:4'),
  baseModel: comicModelEnum.nullish(),
  // When true, always run AI generation even without a prompt (e.g. aspect ratio change, sketch annotations)
  forceGenerate: z.boolean().default(false),
});

const iterateGenerateSchema = z.object({
  projectId: z.number().int(),
  chapterPosition: z.number().int().min(0),
  referenceIds: z.array(z.number().int()).optional(),
  selectedImageIds: z.array(z.number().int()).optional(),
  // For txt2img (no source image)
  prompt: z.string().min(1).max(2000),
  aspectRatio: z.string().default('3:4'),
  baseModel: comicModelEnum.nullish(),
  quantity: z.number().int().min(1).max(4).default(1),
  // For img2img (has source image)
  sourceImageUrl: z.string().optional(),
  sourceImageWidth: z.number().int().positive().optional(),
  sourceImageHeight: z.number().int().positive().optional(),
  // User-imported reference images (from PC or generator)
  userReferenceImages: z
    .array(
      z.object({
        url: z.string(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
    )
    .optional(),
});

const bulkCreatePanelsSchema = z.object({
  projectId: z.number().int(),
  chapterPosition: z.number().int().min(0),
  baseModel: comicModelEnum.nullish(),
  panels: z
    .array(
      z.object({
        // For generation mode (text prompt -> image)
        prompt: z.string().max(2000).optional(),
        // For upload/enhance mode (source image -> comic panel)
        sourceImageUrl: uploadKeySchema.optional(),
        sourceImageWidth: z.number().int().positive().optional(),
        sourceImageHeight: z.number().int().positive().optional(),
        // For import mode (existing image ID)
        imageId: z.number().int().optional(),
        aspectRatio: z.string().default('3:4'),
        // Source-image generation metadata. Populated by the client when
        // available — generator picks supply `civitaiResources` from the
        // workflow step, and dropped files supply whatever PNG/EXIF
        // metadata we can extract. Passed straight into `createImage` so
        // the underlying Image carries proper attribution, and used to
        // write `ImageResourceNew` rows directly for the View-details
        // drawer to surface the model used.
        meta: imageMetaSchema.optional(),
      })
    )
    .min(1)
    .max(20),
});

const updateProjectSchema = z.object({
  id: z.number().int(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(5000).nullish(),
  genre: z.nativeEnum(ComicGenre).nullish(),
  baseModel: comicModelEnum.nullish(),
  coverImageId: z.number().int().nullish(),
  coverUrl: z.string().nullish(),
  heroImageId: z.number().int().nullish(),
  heroUrl: z.string().nullish(),
  heroImagePosition: z.number().int().min(0).max(100).optional(),
  meta: comicProjectMetaSchema.optional(),
});

const deleteReferenceSchema = z.object({
  referenceId: z.number().int(),
});

const updateReferenceSchema = z.object({
  referenceId: z.number().int(),
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((v) => !v.includes('@'), 'Name cannot contain @ character'),
});

// Mirror the model-version EA constraints: timeframe is one of the
// allowed discrete values (3 / 5 / 7 / 9 / 12 / 15 / 30 days), and the
// minimum buzz price matches the model `downloadPrice` floor (100). The
// upper-bound `timeframe` cap and concurrent-EA-chapter cap are enforced
// at the mutation level since they depend on the user's score.
const chapterEarlyAccessConfigSchema = z
  .object({
    buzzPrice: z.number().int().min(100).max(10000),
    timeframe: z
      .number()
      .int()
      .refine(
        (v) => EARLY_ACCESS_CONFIG.timeframeValues.includes(v),
        `Timeframe must be one of: ${EARLY_ACCESS_CONFIG.timeframeValues.join(', ')} days.`
      ),
  })
  .nullable();

/** Active EA chapters for a user — counterpart to `getUserEarlyAccessModelVersions`. */
async function getUserEarlyAccessChapters(userId: number) {
  return dbRead.comicChapter.findMany({
    where: {
      earlyAccessEndsAt: { gt: new Date() },
      project: { userId, status: ComicProjectStatus.Active },
    },
    select: { id: true },
  });
}

/**
 * Apply the same gating model versions use:
 *   - `timeframe` cannot exceed the user's score-based cap
 *   - cannot have more than the score-based cap of EA chapters active at once
 *
 * Pass `excludeChapterId` when re-publishing / updating a chapter that's
 * already in EA, so the chapter doesn't count against its own quota.
 */
async function assertCanGrantEarlyAccess({
  ctx,
  timeframe,
  excludeChapterId,
}: {
  ctx: { user: SessionUser; features: any };
  timeframe: number;
  excludeChapterId?: number;
}) {
  if (ctx.user.isModerator) return;
  const maxDays = getMaxEarlyAccessDays({
    userMeta: ctx.user.meta as any,
    features: ctx.features,
  });
  if (maxDays === 0) {
    throw throwBadRequestError(chapterEarlyAccessLockedMessage(creatorScoreFromSession(ctx.user)));
  }
  if (timeframe > maxDays) {
    throw throwBadRequestError(
      `Early access timeframe exceeds your current limit of ${maxDays} day${
        maxDays === 1 ? '' : 's'
      }.`
    );
  }
  const active = await getUserEarlyAccessChapters(ctx.user.id);
  const maxActive = getMaxEarlyAccessModels({
    userMeta: ctx.user.meta as any,
    features: ctx.features,
  });
  const otherActive = excludeChapterId ? active.filter((c) => c.id !== excludeChapterId) : active;
  if (otherActive.length >= maxActive) {
    throw throwBadRequestError(
      chapterEarlyAccessCapMessage({
        active: otherActive.length,
        limit: maxActive,
        score: creatorScoreFromSession(ctx.user),
      })
    );
  }
}

/** A reference panel's image goes to the generation, so it must not be blocked. */
async function assertReferencePanelImageUnblocked(
  referencePanelId: number | undefined,
  projectId: number
) {
  if (!referencePanelId) return;
  const panel = await dbRead.comicPanel.findFirst({
    where: { id: referencePanelId, chapter: { projectId } },
    select: { imageUrl: true },
  });
  if (panel?.imageUrl) await assertStoredImageUrlsUnblocked([panel.imageUrl]);
}

type ViewerCtx = Parameters<typeof actsAsModerator>[0];
type PanelImageRow = Parameters<typeof blockLeavesMedia>[0];
type PanelMediaRow = { imageUrl: string | null; metadata: unknown };
/** How a read that shows panels (getChapter) builds their display metadata; without it a panel keeps
 *  its stored metadata, less the keys a block refuses. */
type PanelDisplay<P> = {
  isOwner: boolean;
  keepSourceImage: (value: string) => boolean;
  withheld: (panel: P) => boolean;
};

const candidateKeyOf = (entry: unknown) =>
  typeof entry === 'string'
    ? entry
    : typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { key?: unknown }).key === 'string'
    ? (entry as { key: string }).key
    : null;

/** Every stored image key in a panel's `metadata`: its candidates' keys and its source image. */
function storedImageKeys(metadata: unknown) {
  const candidates = (metadata as { candidateImages?: unknown } | null)?.candidateImages;
  const keys = Array.isArray(candidates) ? candidates.map(candidateKeyOf) : [];
  return [...keys, panelSourceImageUrl(metadata)].filter((k): k is string => !!k);
}

/** The panel media of every comics response goes through here or `panelForViewer`; the
 *  `comics.router.viewer-serializers` guard holds each procedure to it. A panel whose image
 *  `blockLeavesMedia` refuses the viewer gives no image, candidate key or source; any other panel
 *  loses each candidate key and source that backs an Image the viewer may not be served. */
async function panelsForViewer<P extends PanelMediaRow & { image?: PanelImageRow | null }>(
  panels: P[],
  ctx: ViewerCtx,
  display: PanelDisplay<P>
): Promise<(P & { metadata: Record<string, unknown> | null })[]>;
async function panelsForViewer<P extends PanelMediaRow & { image?: PanelImageRow | null }>(
  panels: P[],
  ctx: ViewerCtx
): Promise<P[]>;
async function panelsForViewer<P extends PanelMediaRow & { image?: PanelImageRow | null }>(
  panels: P[],
  ctx: ViewerCtx,
  display?: PanelDisplay<P>
) {
  const moderator = actsAsModerator(ctx);
  const mediaRefused = (panel: P) =>
    !!panel.image && !blockLeavesMedia(panel.image, ctx.user?.id, moderator);
  const keys = panels.filter((p) => !mediaRefused(p)).flatMap((p) => storedImageKeys(p.metadata));
  const refused = await refusedImageKeys([...new Set(keys)], ctx);
  return panels.map((panel) => {
    if (mediaRefused(panel))
      return {
        ...panel,
        imageUrl: null,
        metadata: viewerPanelMetadata(panel.metadata, {
          isOwner: display?.isOwner ?? true,
          keepSourceImage: () => false,
          withheld: true,
        }),
      };
    const metadata = display
      ? viewerPanelMetadata(panel.metadata, {
          isOwner: display.isOwner,
          keepSourceImage: (value) => !refused.has(value) && display.keepSourceImage(value),
          withheld: display.withheld(panel),
          keepCandidateKey: (key) => !refused.has(key),
        })
      : withoutRefusedKeys(panel.metadata, refused);
    return { ...panel, metadata };
  });
}

/** One panel as `panelsForViewer` gives it, with `image` (its Image's block row, null when it has
 *  none) used to decide and left out of the result. */
async function panelForViewer<P extends PanelMediaRow>(
  panel: P,
  image: PanelImageRow | null,
  ctx: ViewerCtx
) {
  const [{ image: _image, metadata, ...shown }] = await panelsForViewer([{ ...panel, image }], ctx);
  return { ...shown, metadata: metadata as unknown };
}

/** The stored keys in `values` whose Image rows the viewer may not be served: each row must pass
 *  `isImageServable` and `blockLeavesMedia`. A key with no Image row is not refused. */
async function refusedImageKeys(values: string[], ctx: ViewerCtx) {
  if (!values.length) return new Set<string>();
  const rows = await primarySourceRows(values);
  const moderator = actsAsModerator(ctx);
  return new Set(
    rows
      .filter(
        (row) =>
          !isImageServable(row, ctx.user?.id) || !blockLeavesMedia(row, ctx.user?.id, moderator)
      )
      .map((row) => row.url)
  );
}

/** A panel's stored `metadata` with each candidate key and the source image in `refused` taken out.
 *  Other keys are left as they are. */
function withoutRefusedKeys(metadata: unknown, refused: Set<string>) {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return metadata;
  if (!refused.size) return metadata;
  const record = metadata as Record<string, unknown>;
  const out: Record<string, unknown> = { ...record };
  if (Array.isArray(record.candidateImages))
    out.candidateImages = record.candidateImages.map((entry) => {
      const key = candidateKeyOf(entry);
      if (!key || !refused.has(key)) return entry;
      if (typeof entry === 'string') return { nsfwLevel: null };
      const { key: _key, ...rest } = entry as Record<string, unknown>;
      return rest;
    });
  const source = panelSourceImageUrl(metadata);
  if (source && refused.has(source)) delete out.sourceImageUrl;
  return out;
}

/** Refuses copying a panel whose image a block refuses the viewer: the copy would carry its media. */
function assertPanelCopyable(panel: { image: PanelImageRow | null }, ctx: ViewerCtx) {
  if (panel.image && !blockLeavesMedia(panel.image, ctx.user?.id, actsAsModerator(ctx)))
    throw throwBadRequestError('A panel whose image is blocked cannot be duplicated.');
}

/** What a reference image read needs to show the image and to hold it to its block. */
const referenceImageSelect = {
  id: true,
  url: true,
  width: true,
  height: true,
  ...imageRestrictionSelect,
  ...coverBlockSelect,
} as const;

/** The reference images of every comics response go through here (the same guard as
 *  `panelsForViewer`): only the images the viewer may be served and a block leaves them, and on a
 *  `safeOnly` read only those with a safe level, without the fields that decide the block. */
function referenceForViewer<
  R extends {
    images: { image: PanelImageRow & RestrictableImage & { id: number; url: string } }[];
  }
>(reference: R, ctx: ViewerCtx, { safeOnly = false }: { safeOnly?: boolean } = {}) {
  const moderator = actsAsModerator(ctx);
  const { images, ...rest } = reference;
  return {
    ...rest,
    images: images
      .filter(
        ({ image }) =>
          isImageServable(image, ctx.user?.id) &&
          blockLeavesMedia(image, ctx.user?.id, moderator) &&
          (!safeOnly || !image.nsfwLevel || hasSafeBrowsingLevel(image.nsfwLevel))
      )
      .map(({ image, ...rest }) => {
        const { ingestion: _ingestion, blockedFor: _blockedFor, ...shown } = image;
        return { ...rest, image: shown };
      }),
  };
}

async function primarySourceRows(urls: string[]) {
  // primary: a block or re-rating must show up on the next read, not after replica lag.
  return dbWrite.image.findMany({
    where: { url: { in: urls } },
    select: { url: true, ...imageRestrictionSelect, ...coverBlockSelect },
  });
}

// Shared helper: resolve a reference's images for generation
async function getReferenceImages(referenceId: number) {
  const reference = await dbRead.comicReference.findUnique({
    where: { id: referenceId },
    select: {
      name: true,
      images: {
        orderBy: { position: 'asc' },
        include: {
          image: { select: { id: true, url: true, width: true, height: true, blockedFor: true } },
        },
      },
    },
  });

  if (!reference) return { referenceName: '', refImages: [], skipped: false };
  // A blocked image is never sent to a generation.
  const refImages = reference.images
    .filter((ri) => !ri.image.blockedFor)
    .map((ri) => ({
      imageId: ri.image.id,
      url: getEdgeUrl(ri.image.url, { original: true }),
      width: ri.image.width ?? 512,
      height: ri.image.height ?? 512,
    }));
  return {
    referenceName: reference.name,
    refImages,
    /** Every image it has was left out: the generation runs without this reference. */
    skipped: reference.images.length > 0 && refImages.length === 0,
  };
}

/** An unlock claim older than this is free to take over (or to delete its panel under). */
const UNLOCK_CLAIM_EXPIRY = '10 minutes';
/** Under the claim's expiry, so no charge still in flight is overlapped by a takeover. */
const UNLOCK_CHARGE_TIMEOUT_MS = 150_000;

/**
 * A failed charge write was refused (a 4xx: insufficient Buzz, a refused unlock) or may still have
 * been applied (no response, an upstream 5xx, an unmapped failure).
 */
function chargeOutcomeUnknown(error: unknown) {
  return (
    !(error instanceof TRPCError) ||
    error.code === 'SERVICE_UNAVAILABLE' ||
    error.code === 'INTERNAL_SERVER_ERROR'
  );
}

/**
 * Claims a panel's unlock before the charge, so two concurrent unlocks cannot both pay. The writes
 * that end an unlock replace metadata from the pre-claim copy, which is what drops the claim (a
 * jsonb merge would leave it held). An unconfirmed charge or a crash leaves it to expire.
 */
async function claimPanelUnlock(panelId: number) {
  const token = randomUUID();
  const rows = await dbWrite.$queryRaw<{ id: number }[]>`
    UPDATE "ComicPanel"
    SET metadata = COALESCE(metadata, '{}'::jsonb)
      || jsonb_build_object('unlockClaim', jsonb_build_object('token', ${token}::text, 'at', now()))
    WHERE id = ${panelId}
      AND (metadata->'unlockClaim' IS NULL
        OR (metadata->'unlockClaim'->>'at')::timestamptz < now() - ${UNLOCK_CLAIM_EXPIRY}::interval)
    RETURNING id
  `;
  return rows.length > 0 ? token : null;
}

/**
 * The poll's write. Its metadata is a copy read before the downloads, so the claim comes from the
 * row in the same statement: one an unlock took meanwhile stays, one released since stays released.
 */
async function writePolledPanel(
  panelId: number,
  {
    status,
    errorMessage,
    metadata,
  }: { status: ComicPanelStatus; errorMessage?: string; metadata: Record<string, unknown> }
) {
  const copy = { ...metadata };
  delete copy.unlockClaim;
  await dbWrite.$executeRaw`
    UPDATE "ComicPanel"
    SET status = ${status}::"ComicPanelStatus",
      "errorMessage" = CASE WHEN ${errorMessage !== undefined} THEN ${errorMessage ?? null}::text
        ELSE "errorMessage" END,
      metadata = ${JSON.stringify(copy)}::jsonb || CASE
        WHEN jsonb_typeof(metadata->'unlockClaim') = 'object'
        THEN jsonb_build_object('unlockClaim', metadata->'unlockClaim')
        ELSE '{}'::jsonb END,
      "updatedAt" = now()
    WHERE id = ${panelId}
  `;
}

/** Frees the claim only if it is still this request's own. */
async function releasePanelUnlock(panelId: number, token: string) {
  await dbWrite.$executeRaw`
    UPDATE "ComicPanel" SET metadata = metadata - 'unlockClaim'
    WHERE id = ${panelId} AND metadata->'unlockClaim'->>'token' = ${token}
  `;
}

/** Whether a panel row holds an unlock claim that has not expired (never null). */
const liveUnlockClaim = () => Prisma.sql`COALESCE(
  jsonb_typeof(metadata->'unlockClaim') = 'object'
    AND (metadata->'unlockClaim'->>'at')::timestamptz >= now() - ${UNLOCK_CLAIM_EXPIRY}::interval,
  false
)`;

/**
 * A delete waits while a panel it removes holds a live unlock claim: the claim may cover a charge
 * still landing, and with the panel gone the queue's unlock would no longer defer to it.
 */
const unlockStillFinishing = () =>
  throwBadRequestError('An unlock on this panel is still finishing. Try again in a few minutes.');

/** Refuses a delete of the project while one of its panels holds a live unlock claim. */
async function assertNoLiveUnlockClaim(projectId: number) {
  const rows = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT id FROM "ComicPanel" WHERE "projectId" = ${projectId} AND ${liveUnlockClaim()} LIMIT 1
  `;
  if (rows.length) throw unlockStillFinishing();
}

/** A copied panel's metadata: the source's unlock claim is not the copy's. */
function withoutUnlockClaim(metadata: Prisma.JsonValue | null) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    return metadata ?? undefined;
  const copy = { ...metadata };
  delete copy.unlockClaim;
  return copy;
}

// Shared helper: create a single panel record and submit generation
async function createSinglePanel(args: {
  projectId: number;
  chapterPosition: number;
  referenceIds: number[];
  prompt: string;
  position: number;
  contextPanel: {
    id: number;
    prompt: string;
    enhancedPrompt: string | null;
    imageUrl: string | null;
  } | null;
  allReferenceNames: string[];
  primaryReferenceName: string;
  refImages: { url: string; width: number; height: number }[];
  userId: number;
  ctx: any;
  width: number;
  height: number;
  aspectRatio: string;
  modelConfig: (typeof COMIC_MODEL_CONFIG)[string];
  storyContext?: {
    storyDescription: string;
    previousPanelPrompts: string[];
  };
  /** When true, creates the panel with Enqueued status and skips orchestrator submission.
   *  The background job will submit when queue slots are available. */
  enqueue?: boolean;
}) {
  const {
    projectId,
    chapterPosition,
    referenceIds,
    prompt,
    position,
    contextPanel,
    allReferenceNames,
    primaryReferenceName,
    refImages,
    userId,
    ctx,
    width,
    height,
    aspectRatio,
    modelConfig,
    storyContext,
    enqueue,
  } = args;

  let token: string;
  try {
    token = await getOrchestratorToken(userId, ctx);
  } catch (error) {
    throw throwBadRequestError(getOrchestratorErrorMessage(error));
  }

  // Prompt is used as-is — enhancement happens client-side via enhancePromptText
  const fullPrompt = prompt;

  const metadata: Record<string, any> = {
    previousPanelId: contextPanel?.id ?? null,
    previousPanelPrompt: contextPanel ? contextPanel.enhancedPrompt ?? contextPanel.prompt : null,
    previousPanelImageUrl: contextPanel?.imageUrl ?? null,
    referenceImages: refImages,
    primaryReferenceName,
    allReferenceNames,
    generationParams: {
      engine: modelConfig.engine,
      baseModel: modelConfig.baseModel,
      checkpointVersionId: modelConfig.versionId,
      width,
      height,
      prompt: fullPrompt,
      negativePrompt: '',
    },
  };

  // Store extra fields the job needs to submit generation later
  if (enqueue) {
    metadata.aspectRatio = aspectRatio;
    metadata.maxReferenceImages = modelConfig.maxReferenceImages;
    metadata.isGreen = ctx.features.isGreen ?? false;
  }

  const panel = await dbWrite.comicPanel.create({
    data: {
      projectId,
      chapterPosition,
      prompt,
      enhancedPrompt: null,
      position,
      status: enqueue ? ComicPanelStatus.Enqueued : ComicPanelStatus.Pending,
      metadata,
    },
  });

  // Write to junction table for multi-reference tracking
  if (referenceIds.length > 0) {
    await dbWrite.comicPanelReference.createMany({
      data: referenceIds.map((rid) => ({ panelId: panel.id, referenceId: rid })),
      skipDuplicates: true,
    });
  }

  // When enqueued, skip orchestrator submission — the job handles it
  if (enqueue) return panel;

  try {
    const result = await submitComicGeneration({
      prompt: fullPrompt,
      width,
      height,
      aspectRatio,
      images: refImages,
      modelConfig,
      user: ctx.user! as SessionUser,
      token,
      features: ctx.features,
      isGreen: ctx.features.isGreen,
      allowMatureContent: ctx.domain === 'green' ? false : undefined,
      track: ctx.track,
    });

    const updated = await dbWrite.comicPanel.update({
      where: { id: panel.id },
      data: { workflowId: result.id, status: ComicPanelStatus.Generating },
    });
    sendComicPanelSignal(userId, {
      panelId: updated.id,
      projectId,
      status: updated.status,
      workflowId: result.id,
    });
    return updated;
  } catch (error: any) {
    const errorDetails: string[] = [];
    if (error instanceof Error) {
      errorDetails.push(error.message);
      if (error.cause) errorDetails.push(`Cause: ${JSON.stringify(error.cause)}`);
    } else {
      errorDetails.push(String(error));
    }
    if (error?.response?.data) {
      errorDetails.push(`Response: ${JSON.stringify(error.response.data)}`);
    }
    if (error?.data) {
      errorDetails.push(`Data: ${JSON.stringify(error.data)}`);
    }

    const rawErrorMessage = errorDetails.join(' | ');
    console.error('Comics panel generation failed:', {
      panelId: panel.id,
      error: rawErrorMessage,
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Store a user-friendly message on the panel while keeping full details in logs
    const userFacingError = getOrchestratorErrorMessage(error);
    const updated = await dbWrite.comicPanel.update({
      where: { id: panel.id },
      data: { status: ComicPanelStatus.Failed, errorMessage: userFacingError },
    });
    sendComicPanelSignal(userId, {
      panelId: updated.id,
      projectId,
      status: updated.status,
    });
    return updated;
  }
}

export const comicsRouter = router({
  // Projects
  getMyProjects: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .query(async ({ ctx }) => {
      const projects = await dbRead.comicProject.findMany({
        where: {
          userId: ctx.user.id,
          status: ComicProjectStatus.Active,
        },
        include: {
          coverImage: {
            select: { id: true, url: true, ...imageRestrictionSelect, ...coverBlockSelect },
          },
          heroImage: {
            select: { id: true, url: true, ...imageRestrictionSelect, ...coverBlockSelect },
          },
          chapters: {
            include: {
              _count: { select: { panels: true } },
              panels: {
                where: {
                  OR: [
                    { imageId: null },
                    {
                      image: {
                        AND: [
                          imageNotRestrictedWhere({ viewerId: ctx.user.id }),
                          // The thumbnail is media: a blocked panel gives none to its owner.
                          actsAsModerator(ctx) ? {} : ownerMediaAllowedWhere(),
                        ],
                      },
                    },
                  ],
                },
                take: 1,
                orderBy: { position: 'asc' },
                select: { imageUrl: true },
              },
            },
            orderBy: { position: 'asc' },
          },
        },
        orderBy: { updatedAt: 'desc' },
      });

      return projects.map((p) => {
        const panelCount = p.chapters.reduce((sum, ch) => sum + ch._count.panels, 0);
        const thumbnailUrl =
          p.chapters.flatMap((ch) => ch.panels).find((panel) => panel.imageUrl)?.imageUrl ?? null;

        // On green, strip NSFW cover/hero/thumbnail images so the card is still
        // visible and navigable but doesn't display mature imagery. This route is
        // protected so the viewer is always logged in — allow PG + PG13.
        const moderator = actsAsModerator(ctx);
        const { coverImage: servableCover } = withServableCover(
          p,
          'coverImage',
          ctx.user.id,
          moderator
        );
        const { heroImage: servableHero } = withServableCover(
          p,
          'heroImage',
          ctx.user.id,
          moderator
        );
        const coverImage =
          ctx.features.isGreen && servableCover && !hasSafeBrowsingLevel(servableCover.nsfwLevel)
            ? null
            : servableCover;
        const heroImage =
          ctx.features.isGreen && servableHero && !hasSafeBrowsingLevel(servableHero.nsfwLevel)
            ? null
            : servableHero;
        const safeThumbnailUrl =
          ctx.features.isGreen && Flags.intersects(p.nsfwLevel, nsfwBrowsingLevelsFlag)
            ? null
            : thumbnailUrl;

        return {
          id: p.id,
          name: p.name,
          description: p.description,
          coverImage,
          heroImage,
          nsfwLevel: p.nsfwLevel,
          panelCount,
          thumbnailUrl: safeThumbnailUrl,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        };
      });
    }),

  // Lightweight project shell — project metadata + references + chapter list
  // with precomputed `panelCount` / `hasInProgressPanels`, but NO full panel
  // rows. Use this when the page only needs the chapter list (sidebar, model
  // info, references) and will load actual panels through `getChapter`.
  getProjectShell: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getProjectSchema)
    .query(async ({ ctx, input }) => {
      const project = await dbWrite.comicProject.findUnique({
        where: { id: input.id },
        include: {
          coverImage: {
            select: { id: true, url: true, ...imageRestrictionSelect, ...coverBlockSelect },
          },
          heroImage: {
            select: { id: true, url: true, ...imageRestrictionSelect, ...coverBlockSelect },
          },
          chapters: {
            orderBy: { position: 'asc' },
            include: {
              // Pull `status` plus the panel image's moderation fields so
              // we can derive `panelCount`, `hasInProgressPanels`, AND a
              // per-chapter `hiddenReason` describing why a published
              // chapter isn't reaching the public (a panel image flagged
              // for review or marked TOS-violating).
              panels: {
                select: {
                  status: true,
                  image: {
                    select: { ingestion: true, needsReview: true, tosViolation: true },
                  },
                },
              },
            },
          },
        },
      });

      if (!project) throw throwNotFoundError();
      // Moderators always have access — they need to be able to load any
      // comic's workspace to investigate flagged content. All public-state
      // mutations stay owner-only via their own checks.
      const isOwner = project.userId === ctx.user.id;
      if (!isOwner && !actsAsModerator(ctx)) throw throwAuthorizationError();

      const projectRefs = await dbWrite.comicProjectReference.findMany({
        where: { projectId: project.id },
        select: { referenceId: true },
      });
      const refIds = projectRefs.map((pr) => pr.referenceId);
      const references =
        refIds.length > 0
          ? await dbWrite.comicReference.findMany({
              // For mods viewing someone else's comic, scope by reference
              // ids only — the project-owner constraint on `userId` would
              // hide all of the comic's references.
              where: { id: { in: refIds }, ...(isOwner ? { userId: ctx.user.id } : {}) },
              orderBy: { createdAt: 'asc' },
              include: {
                images: {
                  orderBy: { position: 'asc' },
                  include: {
                    image: {
                      select: {
                        id: true,
                        url: true,
                        width: true,
                        height: true,
                        ...imageRestrictionSelect,
                        ...coverBlockSelect,
                      },
                    },
                  },
                },
              },
            })
          : [];

      const chapters = project.chapters.map((chapter) => {
        const panelCount = chapter.panels.length;
        const hasInProgressPanels = chapter.panels.some(
          (p) => p.status !== ComicPanelStatus.Ready && p.status !== ComicPanelStatus.Failed
        );

        // Per-chapter visibility for the owner: mirror the gates used by
        // `getPublicProjects` and the search index so the editor can tell
        // the creator *why* a Published chapter isn't visible to readers.
        // We only flag Published chapters — drafts are obviously hidden
        // and don't need a separate reason. TOS wins over review when
        // both are present (more severe / final).
        // Compute the flag for *all* chapters, not just Published ones.
        // Draft chapters with already-flagged panels still need the signal
        // — otherwise a creator with three chapters all containing
        // problem panels only sees the warning on whichever one happened
        // to be published, and the rest look fine until publish time.
        // The banner copy ("won't appear publicly until cleared … will
        // publish automatically once approved") reads correctly for both
        // Published (currently hidden) and Draft (will be hidden when
        // published) cases.
        let hiddenReason: 'tosViolation' | 'reviewPending' | null = null;
        const readyPanels = chapter.panels.filter((p) => p.status === ComicPanelStatus.Ready);
        const hasTosImage = readyPanels.some((p) => p.image?.tosViolation === true);
        const hasReviewImage = readyPanels.some(
          (p) =>
            !!p.image &&
            !p.image.tosViolation &&
            (p.image.needsReview != null || p.image.ingestion !== ImageIngestionStatus.Scanned)
        );
        if (hasTosImage) hiddenReason = 'tosViolation';
        else if (hasReviewImage) hiddenReason = 'reviewPending';

        // Strip the panel array from the returned shape — callers that need
        // panel data should use `getChapter`. The derived flags above are
        // all the sidebar needs.
        const { panels: _panels, ...rest } = chapter;
        return { ...rest, panelCount, hasInProgressPanels, hiddenReason };
      });

      // Project-level: TOS-violated projects are hidden globally regardless
      // of chapter state. Per-chapter reasons cover the rest.
      const projectHiddenReason: 'tosViolation' | null = project.tosViolation
        ? 'tosViolation'
        : null;

      // All counters from `ComicProjectMetric` (Postgres). See `getComicMetricRows`.
      const metric = (await getComicMetricRows([project.id])).get(project.id) ?? null;

      const { chapters: _chapters, ...projectRest } = project;
      return {
        ...withServableCover(
          withServableCover(projectRest, 'coverImage', ctx.user.id, actsAsModerator(ctx)),
          'heroImage',
          ctx.user.id,
          actsAsModerator(ctx)
        ),
        chapters,
        references: references.map((ref) =>
          referenceForViewer(ref, ctx, { safeOnly: ctx.features.isGreen })
        ),
        hiddenReason: projectHiddenReason,
        metrics: {
          readerCount: metric?.readerCount ?? 0,
          chapterReadCount: metric?.chapterReadCount ?? 0,
          followerCount: metric?.followerCount ?? 0,
          hiddenCount: metric?.hiddenCount ?? 0,
          tippedCount: metric?.tippedCount ?? 0,
          tippedAmount: metric?.tippedAmountCount ?? 0,
        },
      };
    }),

  // Full panel data for a single chapter. Pair with `getProjectShell`.
  getChapter: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getChapterSchema)
    .query(async ({ ctx, input }) => {
      // Owner check via the parent project — chapters don't store userId.
      // Mods are allowed through for moderation review.
      const project = await dbWrite.comicProject.findUnique({
        where: { id: input.projectId },
        select: { id: true, userId: true },
      });
      if (!project) throw throwNotFoundError();
      const isOwner = project.userId === ctx.user.id;
      if (!isOwner && !actsAsModerator(ctx)) throw throwAuthorizationError();

      const chapter = await dbWrite.comicChapter.findUnique({
        where: {
          projectId_position: {
            projectId: input.projectId,
            position: input.chapterPosition,
          },
        },
        include: {
          panels: {
            orderBy: { position: 'asc' },
            include: {
              references: { select: { referenceId: true } },
              image: {
                select: {
                  ...imageRestrictionSelect,
                  width: true,
                  height: true,
                  // Exposed to the workspace UI so PanelCard can show *why*
                  // a panel is blocking its chapter from publishing.
                  ingestion: true,
                  needsReview: true,
                  tosViolation: true,
                  // `blockedFor` distinguishes `AiNotVerified` (the owner
                  // can fix it by adding generation metadata) from other
                  // moderator-only blocks. `meta` is the current generation
                  // metadata — passed into ImageMetaModal as the starting
                  // values so the owner doesn't lose any prompt they've
                  // already entered.
                  blockedFor: true,
                  meta: true,
                },
              },
            },
          },
        },
      });

      if (!chapter) throw throwNotFoundError();
      const storedImageUrls = new Map(chapter.panels.map((panel) => [panel.id, panel.imageUrl]));
      withholdRestrictedPanelImages([chapter], ctx.user.id, actsAsModerator(ctx));
      // A panel whose image was withheld gives no candidate its key: the selected one is that image.
      const withheld = (panel: { id: number; imageUrl: string | null }) =>
        !!storedImageUrls.get(panel.id) && panel.imageUrl === null;

      // Same green-domain mature-content stripping as `getProject`.
      if (ctx.features.isGreen) {
        stripNsfwPanelImages([chapter], true);
      }

      // A source URL can match several Image rows; keep it only if every row may be shown.
      const sources = [
        ...new Set(
          chapter.panels
            .map((p) => panelSourceImageUrl(p.metadata))
            .filter((v): v is string => v !== null)
        ),
      ];
      const sourceRows = sources.length ? await primarySourceRows(sources) : [];
      const keepSourceImage = (value: string) => {
        const rows = sourceRows.filter((row) => row.url === value);
        return (
          rows.length > 0 &&
          rows.every(
            (row) =>
              isImageServable(row, ctx.user.id) &&
              blockLeavesMedia(row, ctx.user.id, actsAsModerator(ctx)) &&
              (!ctx.features.isGreen || hasSafeBrowsingLevel(row.nsfwLevel))
          )
        );
      };
      return {
        ...chapter,
        panels: await panelsForViewer(chapter.panels, ctx, { isOwner, keepSourceImage, withheld }),
      };
    }),

  getProjectForReader: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getProjectSchema)
    .query(async ({ ctx, input }) => {
      const project = await dbRead.comicProject.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          name: true,
          userId: true,
          user: { select: { username: true } },
          meta: true,
          chapters: {
            orderBy: { position: 'asc' },
            select: {
              projectId: true,
              name: true,
              position: true,
              // Needed by `stripNsfwPanelImages` as a fallback when a panel
              // has an `imageUrl` but no associated Image record.
              nsfwLevel: true,
              panels: {
                where: {
                  status: ComicPanelStatus.Ready,
                  imageUrl: { not: null },
                },
                orderBy: { position: 'asc' },
                select: {
                  id: true,
                  imageUrl: true,
                  prompt: true,
                  position: true,
                  // Pull the underlying Image's nsfwLevel so the reader can
                  // blur and hide mature panels on a domain that doesn't
                  // permit them, instead of bypassing the site's NSFW guard.
                  image: { select: panelImageVisibilitySelect },
                },
              },
            },
          },
        },
      });

      if (!project || (project.userId !== ctx.user.id && !actsAsModerator(ctx))) {
        throw throwAuthorizationError();
      }
      withholdRestrictedPanelImages(project.chapters, ctx.user.id, actsAsModerator(ctx));

      // Server-side gate: on green, strip mature panels' `imageUrl` so the
      // raw CDN URL never reaches the client. Client-side blur on its own
      // leaves the URL in the response, which means a determined user
      // could fetch the original or trigger the export-to-CBZ button.
      if (ctx.features.isGreen) {
        stripNsfwPanelImages(project.chapters, true);
      }

      return {
        id: project.id,
        name: project.name,
        username: project.user.username,
        meta: parseComicProjectMeta(project.meta),
        chapters: project.chapters,
      };
    }),

  // Public queries — no auth required
  getPublicProjects: comicPublicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getPublicComicProjectsSchema)
    .query(({ input, ctx }) => getPublicComicProjects({ input, ctx })),

  getPublicProjectForReader: comicPublicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(z.object({ id: z.number().int() }))
    .query(({ input, ctx }) => getPublicComicForReader({ input, ctx })),

  // Dynamic pricing — whatIf cost estimate for panel generation
  /**
   * Unified cost estimation for all comic generation operations:
   * - Panel creation (from project page)
   * - Enhance panel (img2img with source)
   * - Iterative editor (with references and source images)
   * - Smart create (bulk panels)
   */
  getGenerationCostEstimate: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .input(
      z
        .object({
          baseModel: z.string().nullish(),
          aspectRatio: z.string().default(DEFAULT_ASPECT_RATIO),
          quantity: z.number().int().min(1).max(4).default(1),
          // Reference IDs from @mentioned characters - fetched server-side
          referenceIds: z.array(z.number().int().positive()).optional(),
          // Optional filter for specific images when user manually selected
          selectedImageIds: z.array(z.number().int().positive()).optional(),
          // Source image for img2img workflow (enhance panel)
          sourceImage: z
            .object({
              url: z.string(),
              width: z.number().int().positive(),
              height: z.number().int().positive(),
            })
            .nullish(),
          // User-imported reference images (directly passed, not from @mentions)
          userReferenceImages: z
            .array(
              z.object({
                url: z.string(),
                width: z.number().int().positive(),
                height: z.number().int().positive(),
              })
            )
            .optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      await assertGenerationInputsUsable({
        urls: [input?.sourceImage?.url, ...(input?.userReferenceImages ?? []).map((r) => r.url)],
        userId: ctx.user.id,
        entry: 'comicsCostEstimate',
        isApiCaller: ctx.apiKeyId != null,
      });
      try {
        const token = await getOrchestratorToken(ctx.user.id, ctx);
        const modelConfig = getComicModelConfig(input?.baseModel);
        const aspectRatio = input?.aspectRatio ?? DEFAULT_ASPECT_RATIO;
        const quantity = input?.quantity ?? 1;
        const hasSourceImage = !!input?.sourceImage;

        // Use img2img version if source image is provided and model supports it
        const effectiveVersionId =
          hasSourceImage && modelConfig.img2imgVersionId
            ? modelConfig.img2imgVersionId
            : modelConfig.versionId;

        // Build images array for accurate pricing
        const allImages: { url: string; width: number; height: number }[] = [];

        // 1. Add source image first if present (for img2img)
        if (input?.sourceImage) {
          const sourceEdgeUrl = getEdgeUrl(input.sourceImage.url, { original: true });
          allImages.push({
            url: sourceEdgeUrl,
            width: input.sourceImage.width,
            height: input.sourceImage.height,
          });
        }

        // 2. Fetch reference images server-side from @mentioned characters
        if (input?.referenceIds && input.referenceIds.length > 0) {
          const characterRefImages: {
            imageId: number;
            url: string;
            width: number;
            height: number;
          }[] = [];
          const ownRefs = await dbRead.comicReference.findMany({
            where: { id: { in: input.referenceIds }, userId: ctx.user.id },
            select: { id: true },
          });
          for (const { id: refId } of ownRefs) {
            const { refImages: imgs } = await getReferenceImages(refId);
            characterRefImages.push(...imgs);
          }

          // Filter to user-selected images if specified
          const selectedImageIdSet =
            input?.selectedImageIds && input.selectedImageIds.length > 0
              ? new Set(input.selectedImageIds)
              : null;
          const filteredRefImages = selectedImageIdSet
            ? characterRefImages.filter((img) => selectedImageIdSet.has(img.imageId))
            : characterRefImages;

          for (const img of filteredRefImages) {
            const edgeUrl = getEdgeUrl(img.url, { original: true });
            allImages.push({ url: edgeUrl, width: img.width, height: img.height });
          }
        }

        // 3. Add user-imported reference images (directly passed)
        if (input?.userReferenceImages && input.userReferenceImages.length > 0) {
          for (const ref of input.userReferenceImages) {
            const refEdgeUrl = getEdgeUrl(ref.url, { original: true });
            allImages.push({ url: refEdgeUrl, width: ref.width, height: ref.height });
          }
        }

        // prompt intentionally omitted — whatIfPresetImageGen supplies a
        // `cost-estimation` placeholder so validation passes.
        return whatIfPresetImageGen({
          aspectRatio,
          quantity,
          images: allImages.length > 0 ? allImages : null,
          modelConfig,
          versionIdOverride: effectiveVersionId,
          user: ctx.user as SessionUser,
          token,
          flags: ctx.features,
          currencies: getAllowedAccountTypes(ctx.features, ['blue']),
        });
      } catch (error) {
        console.error('Comics getGenerationCostEstimate failed:', error);
        throw error;
      }
    }),

  getPromptEnhanceCostEstimate: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .query(async ({ ctx }) => {
      try {
        const token = await getOrchestratorToken(ctx.user.id, ctx);
        return orchestratorChatCompletionCost({
          token,
          model: DEFAULT_CHAT_COMPLETION_MODEL,
          messages: [
            { role: 'system', content: 'You enhance prompts.' },
            { role: 'user', content: 'A sample prompt for cost estimation.' },
          ],
          maxTokens: 512,
          currencies: getAllowedAccountTypes(ctx.features, ['blue']),
        });
      } catch (error) {
        console.error('Comics getPromptEnhanceCostEstimate failed:', error);
        return { cost: 0, ready: false };
      }
    }),

  /** Enhances a prompt via LLM and returns the enhanced text without generating an image. */
  enhancePromptText: comicGenerationProcedure
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(
      z.object({
        projectId: z.number().int(),
        chapterPosition: z.number().int().min(0),
        prompt: z.string().min(1).max(2000),
        useContext: z.boolean().default(true),
        insertAtPosition: z.number().int().min(0).optional(),
      })
    )
    .use(isChapterOwner)
    .mutation(async ({ ctx, input }) => {
      // The enhancement is a paid step toward a panel the kill switch would refuse: refuse it first.
      await assertPresetGenerationAllowed(ctx.user! as SessionUser);
      // Get all user's ready references for prompt context
      const allUserRefs = await dbRead.comicReference.findMany({
        where: { userId: ctx.user!.id, status: ComicReferenceStatus.Ready },
        select: { id: true, name: true },
      });

      // Resolve @mentions to get mentioned character names
      const { mentionedIds } = resolveReferenceMentions({
        prompt: input.prompt,
        references: allUserRefs,
      });
      const mentionedRefIdSet = new Set(mentionedIds);
      const mentionedNames = allUserRefs
        .filter((r) => mentionedRefIdSet.has(r.id))
        .map((r) => r.name);
      const primaryReferenceName = mentionedNames[0] ?? '';

      // Get context panel if requested
      let contextPanel: {
        id: number;
        prompt: string;
        enhancedPrompt: string | null;
        imageUrl: string | null;
      } | null = null;

      if (input.useContext) {
        if (input.insertAtPosition != null) {
          contextPanel = await dbRead.comicPanel.findFirst({
            where: {
              projectId: input.projectId,
              chapterPosition: input.chapterPosition,
              position: { lt: input.insertAtPosition },
            },
            orderBy: { position: 'desc' },
            select: { id: true, prompt: true, enhancedPrompt: true, imageUrl: true },
          });
        } else {
          contextPanel = await dbRead.comicPanel.findFirst({
            where: { projectId: input.projectId, chapterPosition: input.chapterPosition },
            orderBy: { position: 'desc' },
            select: { id: true, prompt: true, enhancedPrompt: true, imageUrl: true },
          });
        }
      }

      const token = await getOrchestratorToken(ctx.user!.id, ctx);

      const enhancedPrompt = await enhanceComicPrompt({
        token,
        userPrompt: input.prompt,
        characterName: primaryReferenceName,
        characterNames: mentionedNames,
        previousPanel: contextPanel ?? undefined,
        currencies: getAllowedAccountTypes(ctx.features, ['blue']),
      });

      return { enhancedPrompt };
    }),

  getPlanChapterCostEstimate: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .query(async ({ ctx }) => {
      try {
        const token = await getOrchestratorToken(ctx.user.id, ctx);
        return orchestratorChatCompletionCost({
          token,
          model: DEFAULT_CHAT_COMPLETION_MODEL,
          messages: [
            { role: 'system', content: 'You plan comic panels.' },
            { role: 'user', content: 'A sample story for cost estimation.' },
          ],
          maxTokens: 2048,
          currencies: getAllowedAccountTypes(ctx.features, ['blue']),
        });
      } catch (error) {
        console.error('Comics getPlanChapterCostEstimate failed:', error);
        return { cost: 0, ready: false };
      }
    }),

  createProject: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(createProjectSchema)
    .mutation(async ({ ctx, input }) => {
      await throwOnBlockedUserContent([input.name, input.description], {
        isModerator: ctx.user.isModerator,
        surface: 'comic',
      });
      // Images first, so a refused cover or hero leaves no project behind.
      const cover = input.coverUrl
        ? await createImage({
            url: input.coverUrl,
            type: 'image',
            clientUrl: true,
            userId: ctx.user.id,
          })
        : null;
      const hero = input.heroUrl
        ? await createImage({
            url: input.heroUrl,
            type: 'image',
            clientUrl: true,
            userId: ctx.user.id,
          })
        : null;
      const project = await dbWrite.comicProject.create({
        data: {
          userId: ctx.user.id,
          name: input.name,
          description: input.description ?? null,
          genre: input.genre ?? null,
          heroImagePosition: input.heroImagePosition ?? 50,
          coverImageId: cover?.id ?? null,
          heroImageId: hero?.id ?? null,
          chapters: {
            create: {
              name: 'Chapter 1',
              position: 0,
            },
          },
        },
        include: {
          chapters: true,
        },
      });

      await comicsSearchIndex.queueUpdate(
        [{ id: project.id, action: SearchIndexUpdateQueueAction.Update }],
        { reason: 'comic-image' }
      );

      return project;
    }),

  deleteProject: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaDelete })
    .input(getProjectSchema)
    .mutation(async ({ ctx, input }) => {
      const project = await dbRead.comicProject.findUnique({
        where: { id: input.id },
        select: { userId: true },
      });
      if (!project || project.userId !== ctx.user.id) {
        throw throwAuthorizationError();
      }
      await assertNoLiveUnlockClaim(input.id);

      await dbWrite.comicProject.update({
        where: { id: input.id },
        data: { status: ComicProjectStatus.Deleted },
      });

      await comicsSearchIndex.queueUpdate(
        [{ id: input.id, action: SearchIndexUpdateQueueAction.Delete }],
        { reason: 'comic-edit' }
      );

      return { success: true };
    }),

  updateProject: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(updateProjectSchema)
    .mutation(async ({ ctx, input }) => {
      // primary: a lagging replica would show a just-saved cover as changed and refuse it.
      const project = await dbWrite.comicProject.findUnique({
        where: { id: input.id },
        select: {
          userId: true,
          coverImageId: true,
          heroImageId: true,
          coverImage: { select: { url: true } },
          heroImage: { select: { url: true } },
        },
      });
      if (!project || project.userId !== ctx.user.id) {
        throw throwAuthorizationError();
      }
      await throwOnBlockedUserContent([input.name, input.description], {
        isModerator: ctx.user.isModerator,
        surface: 'comic',
      });

      const data: Record<string, any> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.description !== undefined) data.description = input.description;
      if (input.genre !== undefined) data.genre = input.genre;
      if (input.baseModel !== undefined) data.baseModel = input.baseModel;
      if (input.heroImagePosition !== undefined) data.heroImagePosition = input.heroImagePosition;
      if (input.meta !== undefined) data.meta = input.meta;

      const coverChanged =
        input.coverImageId === undefined &&
        input.coverUrl !== undefined &&
        input.coverUrl !== project.coverImage?.url;
      const heroChanged =
        input.heroImageId === undefined &&
        input.heroUrl !== undefined &&
        input.heroUrl !== project.heroImage?.url;
      // Both, before either image is created.
      assertBareUploadKeys([
        coverChanged ? input.coverUrl || null : null,
        heroChanged ? input.heroUrl || null : null,
      ]);

      // Cover image: an existing Image ID, or an uploaded image (creates an Image record).
      if (input.coverImageId !== undefined) {
        // A route may only point at an image the caller may use. Clearing, or re-sending the
        // project's current image, needs no lookup.
        if (input.coverImageId !== null && input.coverImageId !== project.coverImageId) {
          await getOwnedImageOrThrow(input.coverImageId, ctx.user.id);
        }
        data.coverImageId = input.coverImageId;
      } else if (coverChanged) {
        if (input.coverUrl) {
          const image = await createImage({
            url: input.coverUrl,
            type: 'image',
            clientUrl: true,
            userId: ctx.user.id,
          });
          data.coverImageId = image.id;
        } else {
          data.coverImageId = null;
        }
      }

      // Hero image: an existing Image ID, or an uploaded image (creates an Image record).
      if (input.heroImageId !== undefined) {
        if (input.heroImageId !== null && input.heroImageId !== project.heroImageId) {
          await getOwnedImageOrThrow(input.heroImageId, ctx.user.id);
        }
        data.heroImageId = input.heroImageId;
      } else if (heroChanged) {
        if (input.heroUrl) {
          const image = await createImage({
            url: input.heroUrl,
            type: 'image',
            clientUrl: true,
            userId: ctx.user.id,
          });
          data.heroImageId = image.id;
        } else {
          data.heroImageId = null;
        }
      }

      let updated = await dbWrite.comicProject.update({
        where: { id: input.id },
        data,
      });

      if ('coverImageId' in data || 'heroImageId' in data) {
        await updateComicNsfwLevels([input.id]);
        updated = await dbWrite.comicProject.findUniqueOrThrow({ where: { id: input.id } });
      }

      await comicsSearchIndex.queueUpdate(
        [{ id: input.id, action: SearchIndexUpdateQueueAction.Update }],
        { reason: 'comic-image' }
      );

      return updated;
    }),

  // Chapters
  createChapter: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(createChapterSchema)
    .use(isProjectOwner)
    .mutation(async ({ ctx, input }) => {
      await throwOnBlockedUserContent(input.name, {
        isModerator: ctx.user?.isModerator,
        surface: 'comic',
      });
      // Auto-increment position (use dbWrite to reduce read→write race window)
      const lastChapter = await dbWrite.comicChapter.findFirst({
        where: { projectId: input.projectId },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      const nextPosition = (lastChapter?.position ?? -1) + 1;

      const chapter = await dbWrite.comicChapter.create({
        data: {
          projectId: input.projectId,
          name: input.name,
          position: nextPosition,
        },
      });

      return chapter;
    }),

  updateChapter: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(updateChapterSchema)
    .mutation(async ({ ctx, input }) => {
      const chapter = await dbRead.comicChapter.findUnique({
        where: {
          projectId_position: { projectId: input.projectId, position: input.chapterPosition },
        },
        include: { project: { select: { userId: true } } },
      });
      if (!chapter || chapter.project.userId !== ctx.user.id) {
        throw throwAuthorizationError();
      }
      await throwOnBlockedUserContent(input.name, {
        isModerator: ctx.user.isModerator,
        surface: 'comic',
      });

      const updated = await dbWrite.comicChapter.update({
        where: {
          projectId_position: { projectId: input.projectId, position: input.chapterPosition },
        },
        data: { name: input.name },
      });

      return updated;
    }),

  deleteChapter: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaDelete })
    .input(deleteChapterSchema)
    .mutation(async ({ ctx, input }) => {
      const chapter = await dbRead.comicChapter.findUnique({
        where: {
          projectId_position: { projectId: input.projectId, position: input.chapterPosition },
        },
        include: { project: { select: { userId: true } } },
      });
      if (!chapter || chapter.project.userId !== ctx.user.id) {
        throw throwAuthorizationError();
      }

      await dbWrite.$transaction(async (tx) => {
        // The chapter row first, so a reorder cannot move another chapter into this position; then
        // its panels, so an unlock cannot claim one between the check and the delete.
        await tx.$queryRaw`
          SELECT 1 FROM "ComicChapter"
          WHERE "projectId" = ${input.projectId} AND position = ${input.chapterPosition}
          FOR UPDATE
        `;
        const panels = await tx.$queryRaw<{ live: boolean }[]>`
          SELECT ${liveUnlockClaim()} AS live FROM "ComicPanel"
          WHERE "projectId" = ${input.projectId} AND "chapterPosition" = ${input.chapterPosition}
          FOR UPDATE
        `;
        if (panels.some((p) => p.live)) throw unlockStillFinishing();
        await tx.comicChapter.delete({
          where: {
            projectId_position: { projectId: input.projectId, position: input.chapterPosition },
          },
        });

        // Get remaining chapter positions inside the transaction to avoid race conditions
        const allChapters = await tx.comicChapter.findMany({
          where: { projectId: input.projectId },
          orderBy: { position: 'asc' },
          select: { position: true },
        });
        const remaining = allChapters;

        // Re-compact positions so chapters are sequential (0, 1, 2, ...)
        if (remaining.length > 0) {
          const TEMP_OFFSET = 10000;
          // Phase 1: move to temp positions to avoid PK conflicts
          for (let i = 0; i < remaining.length; i++) {
            if (remaining[i].position !== i) {
              await tx.comicChapter.update({
                where: {
                  projectId_position: {
                    projectId: input.projectId,
                    position: remaining[i].position,
                  },
                },
                data: { position: TEMP_OFFSET + i },
              });
            }
          }
          // Phase 2: move from temp to final sequential positions
          for (let i = 0; i < remaining.length; i++) {
            if (remaining[i].position !== i) {
              await tx.comicChapter.update({
                where: {
                  projectId_position: { projectId: input.projectId, position: TEMP_OFFSET + i },
                },
                data: { position: i },
              });
            }
          }
        }

        // Reads of the deleted chapter are removed via the ComicChapterRead FK
        // cascade; reads of the surviving chapters are keyed by stable id and
        // unaffected by the position recompaction above.
      });

      // Recalculate project NSFW level after chapter removal
      await updateComicNsfwLevels([input.projectId]).catch((e) =>
        console.error(`Failed to update project NSFW after chapter delete:`, e)
      );

      return { success: true };
    }),

  duplicatePanel: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(duplicatePanelSchema)
    .mutation(async ({ ctx, input }) => {
      const panel = await dbRead.comicPanel.findUnique({
        where: { id: input.panelId },
        include: {
          chapter: { include: { project: { select: { userId: true } } } },
          references: { select: { referenceId: true } },
          image: { select: panelImageVisibilitySelect },
        },
      });

      if (!panel || panel.chapter.project.userId !== ctx.user!.id) {
        throw throwAuthorizationError();
      }
      assertPanelCopyable(panel, ctx);

      if (panel.status !== ComicPanelStatus.Ready || !panel.imageUrl) {
        throw throwBadRequestError('Only completed panels with an image can be duplicated.');
      }

      const newPanel = await dbWrite.$transaction(async (tx) => {
        // Shift subsequent panels positions +1
        await tx.comicPanel.updateMany({
          where: {
            projectId: panel.projectId,
            chapterPosition: panel.chapterPosition,
            position: { gt: panel.position },
          },
          data: { position: { increment: 1 } },
        });

        // Create duplicate at position+1
        const created = await tx.comicPanel.create({
          data: {
            projectId: panel.projectId,
            chapterPosition: panel.chapterPosition,
            prompt: panel.prompt,
            enhancedPrompt: panel.enhancedPrompt,
            imageUrl: panel.imageUrl,
            imageId: panel.imageId,
            position: panel.position + 1,
            status: panel.imageUrl ? ComicPanelStatus.Ready : ComicPanelStatus.Pending,
            metadata: withoutUnlockClaim(panel.metadata),
          },
        });

        // Copy references
        if (panel.references.length > 0) {
          await tx.comicPanelReference.createMany({
            data: panel.references.map((r) => ({
              panelId: created.id,
              referenceId: r.referenceId,
            })),
            skipDuplicates: true,
          });
        }

        return created;
      });

      sendComicPanelSignal(ctx.user!.id, {
        panelId: newPanel.id,
        projectId: panel.projectId,
        status: newPanel.status,
        imageUrl: newPanel.imageUrl,
      });

      return panelForViewer(newPanel, panel.image, ctx);
    }),

  duplicateChapter: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(duplicateChapterSchema)
    .use(isChapterOwner)
    .mutation(async ({ ctx, input }) => {
      const chapter = await dbRead.comicChapter.findUnique({
        where: {
          projectId_position: { projectId: input.projectId, position: input.chapterPosition },
        },
        include: {
          project: { select: { userId: true } },
          panels: {
            orderBy: { position: 'asc' },
            include: {
              references: { select: { referenceId: true } },
              image: { select: panelImageVisibilitySelect },
            },
          },
        },
      });

      if (!chapter || chapter.project.userId !== ctx.user!.id) {
        throw throwAuthorizationError();
      }
      for (const panel of chapter.panels) assertPanelCopyable(panel, ctx);

      // Don't allow duplicating chapters with incomplete panels
      const incompletePanels = chapter.panels.filter(
        (p) => p.status !== ComicPanelStatus.Ready && p.status !== ComicPanelStatus.Failed
      );
      if (incompletePanels.length > 0) {
        throw throwBadRequestError(
          'Cannot duplicate a chapter with pending or generating panels. Wait for all panels to complete first.'
        );
      }

      const TEMP_OFFSET = 10000;

      const newChapter = await dbWrite.$transaction(async (tx) => {
        // Get all chapters after the source to shift them
        const chaptersToShift = await tx.comicChapter.findMany({
          where: {
            projectId: input.projectId,
            position: { gt: input.chapterPosition },
          },
          orderBy: { position: 'desc' },
          select: { position: true },
        });

        // Phase 1: move to temp positions to avoid PK conflicts
        for (const ch of chaptersToShift) {
          await tx.comicChapter.update({
            where: { projectId_position: { projectId: input.projectId, position: ch.position } },
            data: { position: TEMP_OFFSET + ch.position },
          });
        }

        // Phase 2: move from temp to final positions (+1)
        for (const ch of chaptersToShift) {
          await tx.comicChapter.update({
            where: {
              projectId_position: {
                projectId: input.projectId,
                position: TEMP_OFFSET + ch.position,
              },
            },
            data: { position: ch.position + 1 },
          });
        }

        // Create copy chapter at position+1
        const created = await tx.comicChapter.create({
          data: {
            projectId: input.projectId,
            name: `${chapter.name} (copy)`,
            position: input.chapterPosition + 1,
            status: ComicChapterStatus.Draft,
          },
        });

        // Copy all panels with references
        for (const panel of chapter.panels) {
          const newPanel = await tx.comicPanel.create({
            data: {
              projectId: input.projectId,
              chapterPosition: created.position,
              prompt: panel.prompt,
              enhancedPrompt: panel.enhancedPrompt,
              imageUrl: panel.imageUrl,
              imageId: panel.imageId,
              position: panel.position,
              status: panel.imageUrl ? ComicPanelStatus.Ready : ComicPanelStatus.Pending,
              metadata: withoutUnlockClaim(panel.metadata),
            },
          });

          if (panel.references.length > 0) {
            await tx.comicPanelReference.createMany({
              data: panel.references.map((r) => ({
                panelId: newPanel.id,
                referenceId: r.referenceId,
              })),
              skipDuplicates: true,
            });
          }
        }

        // No read-state cleanup needed: ComicChapterRead is keyed by stable
        // chapter id, so duplicating a chapter leaves existing reads intact.
        return created;
      });

      return newChapter;
    }),

  reorderChapters: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(reorderChaptersSchema)
    .use(isProjectOwner)
    .mutation(async ({ input }) => {
      const { projectId, order } = input;
      const TEMP_OFFSET = 1000;

      await dbWrite.$transaction(async (tx) => {
        // Phase 1: Move chapters to temp positions (avoids PK conflicts)
        for (let i = 0; i < order.length; i++) {
          await tx.comicChapter.update({
            where: { projectId_position: { projectId, position: order[i] } },
            data: { position: TEMP_OFFSET + i },
          });
        }
        // Phase 2: Move from temp to final positions
        for (let i = 0; i < order.length; i++) {
          await tx.comicChapter.update({
            where: { projectId_position: { projectId, position: TEMP_OFFSET + i } },
            data: { position: i },
          });
        }
        // No read-state cleanup needed: ComicChapterRead is keyed by stable
        // chapter id, so reordering positions doesn't affect which chapters a
        // user has read (this is the whole reason reads moved off the position array).
      });

      return { success: true };
    }),

  // References — single creation path (images added separately)

  createReference: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(createReferenceSchema)
    .mutation(async ({ ctx, input }) => {
      await throwOnBlockedUserContent([input.name, input.description], {
        isModerator: ctx.user!.isModerator,
        surface: 'comic',
      });
      const reference = await dbWrite.comicReference.create({
        data: {
          userId: ctx.user!.id,
          name: input.name,
          type: input.type,
          description: input.description,
          status: ComicReferenceStatus.Pending,
        },
      });

      // Auto-associate with project if projectId provided
      if (input.projectId) {
        // Verify project ownership
        const project = await dbRead.comicProject.findUnique({
          where: { id: input.projectId },
          select: { userId: true },
        });
        if (project && project.userId === ctx.user!.id) {
          await dbWrite.comicProjectReference.create({
            data: {
              projectId: input.projectId,
              referenceId: reference.id,
            },
          });
        }
      }

      return reference;
    }),

  // Add reference images — creates Image records + join rows + triggers ingestion
  addReferenceImages: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(addReferenceImagesSchema)
    .mutation(async ({ ctx, input }) => {
      const reference = await dbRead.comicReference.findUnique({
        where: { id: input.referenceId },
      });

      if (!reference || reference.userId !== ctx.user!.id) {
        throw throwAuthorizationError();
      }

      // Get current max position (use dbWrite to reduce read→write race window)
      const lastImage = await dbWrite.comicReferenceImage.findFirst({
        where: { referenceId: input.referenceId },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      let nextPosition = (lastImage?.position ?? -1) + 1;

      for (const img of input.images) {
        const image = await createImage({
          url: img.url,
          type: 'image',
          clientUrl: true,
          userId: ctx.user!.id,
          width: img.width,
          height: img.height,
        });

        await dbWrite.comicReferenceImage.create({
          data: {
            referenceId: input.referenceId,
            imageId: image.id,
            position: nextPosition++,
          },
        });
      }

      // Set reference status to Ready
      const updated = await dbWrite.comicReference.update({
        where: { id: input.referenceId },
        data: {
          status: ComicReferenceStatus.Ready,
          errorMessage: null,
        },
        include: {
          images: {
            orderBy: { position: 'asc' },
            include: { image: { select: referenceImageSelect } },
          },
        },
      });

      return referenceForViewer(updated, ctx);
    }),

  // Poll reference status — just return current status + images
  pollReferenceStatus: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(z.object({ referenceId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      // Use dbWrite for read-after-write consistency when polling after mutations
      const reference = await dbWrite.comicReference.findUnique({
        where: { id: input.referenceId },
        include: {
          images: {
            orderBy: { position: 'asc' },
            include: {
              image: { select: referenceImageSelect },
            },
          },
        },
      });

      if (!reference || reference.userId !== ctx.user.id) {
        throw throwAuthorizationError();
      }

      return {
        id: reference.id,
        status: reference.status,
        images: referenceForViewer(reference, ctx).images,
      };
    }),

  // Panels — generation via the preset image-gen service (model determined by project)
  createPanel: comicGenerationProcedure
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(createPanelSchema)
    .use(isChapterOwner)
    .mutation(async ({ ctx, input }) => {
      // Verify chapter ownership
      const chapter = await dbRead.comicChapter.findUnique({
        where: {
          projectId_position: { projectId: input.projectId, position: input.chapterPosition },
        },
        include: {
          project: {
            select: { id: true, userId: true, baseModel: true },
          },
        },
      });
      if (!chapter || chapter.project.userId !== ctx.user!.id) {
        throw throwAuthorizationError();
      }
      await assertReferencePanelImageUnblocked(input.referencePanelId, input.projectId);

      // Get all user's ready references for prompt context and auto-detection
      const allUserRefs = await dbRead.comicReference.findMany({
        where: { userId: ctx.user!.id, status: ComicReferenceStatus.Ready },
        select: { id: true, name: true },
      });
      const allReferenceNames = allUserRefs.map((r) => r.name);

      // Always resolve @mentions from prompt for panel-reference tracking
      const allowedRefIds = new Set(allUserRefs.map((r) => r.id));
      const { mentionedIds } = resolveReferenceMentions({
        prompt: input.prompt,
        references: allUserRefs,
      });
      const mentionedReferenceIds = mentionedIds;

      // Determine which references provide images for generation.
      // Only include references explicitly @mentioned in the prompt or passed via referenceIds
      let generationReferenceIds: number[];
      if (input.referenceIds && input.referenceIds.length > 0) {
        if (input.referenceIds.some((id) => !allowedRefIds.has(id))) {
          throw throwAuthorizationError();
        }
        generationReferenceIds = input.referenceIds;
      } else {
        generationReferenceIds = mentionedReferenceIds;
      }

      // If inserting at a specific position, shift existing panels and get the
      // panel just before the insertion point for context. Otherwise use the last panel.
      let nextPosition: number;
      let contextPanel: {
        id: number;
        position: number;
        prompt: string;
        enhancedPrompt: string | null;
        imageUrl: string | null;
      } | null;

      if (input.position != null) {
        // Get the panel just before the insertion point (position < input.position)
        contextPanel = await dbRead.comicPanel.findFirst({
          where: {
            projectId: input.projectId,
            chapterPosition: input.chapterPosition,
            position: { lt: input.position },
          },
          orderBy: { position: 'desc' },
          select: { id: true, position: true, prompt: true, enhancedPrompt: true, imageUrl: true },
        });

        // Shift panels at or after the insertion point
        await dbWrite.comicPanel.updateMany({
          where: {
            projectId: input.projectId,
            chapterPosition: input.chapterPosition,
            position: { gte: input.position },
          },
          data: { position: { increment: 1 } },
        });
        nextPosition = input.position;
      } else {
        // Appending: use the last panel for context (use dbWrite to reduce race window)
        contextPanel = await dbWrite.comicPanel.findFirst({
          where: { projectId: input.projectId, chapterPosition: input.chapterPosition },
          orderBy: { position: 'desc' },
          select: { id: true, position: true, prompt: true, enhancedPrompt: true, imageUrl: true },
        });
        nextPosition = (contextPanel?.position ?? -1) + 1;
      }

      // Get reference images for generation (skip if no references)
      let primaryReferenceName = '';
      let combinedRefImages: { url: string; width: number; height: number }[] = [];
      let referenceImagesSkipped = false;

      if (generationReferenceIds.length > 0) {
        const allRefImages: { imageId: number; url: string; width: number; height: number }[] = [];

        for (const refId of generationReferenceIds) {
          const { referenceName, refImages: imgs, skipped } = await getReferenceImages(refId);
          if (!primaryReferenceName && referenceName) primaryReferenceName = referenceName;
          if (skipped) referenceImagesSkipped = true;
          allRefImages.push(...imgs);
        }

        // Filter to user-selected images if specified
        const selectedImageIdSet =
          input.selectedImageIds && input.selectedImageIds.length > 0
            ? new Set(input.selectedImageIds)
            : null;
        combinedRefImages = (
          selectedImageIdSet
            ? allRefImages.filter((img) => selectedImageIdSet.has(img.imageId))
            : allRefImages
        ).map(({ url, width, height }) => ({ url, width, height }));

        if (combinedRefImages.length === 0) {
          throw throwBadRequestError('References have no reference images');
        }
      }

      // Conditionally use previous panel context for prompt enhancement
      const effectiveContext = input.useContext ? contextPanel : null;
      const modelConfig = getComicModelConfig(input.baseModel ?? chapter.project.baseModel);
      const { width: panelWidth, height: panelHeight } = getAspectRatioDimensions(
        input.aspectRatio,
        modelConfig
      );

      let token: string;
      try {
        token = await getOrchestratorToken(ctx.user!.id, ctx);
      } catch (error) {
        throw throwBadRequestError(getOrchestratorErrorMessage(error));
      }

      // Enforce queue limits before generation
      try {
        await assertCanGenerate(token, ctx.user?.tier ?? 'free', 1);
      } catch (error) {
        // Re-throw known tRPC errors (e.g. queue full) as-is
        if ((error as any)?.code === 'BAD_REQUEST' || (error as any)?.code === 'TOO_MANY_REQUESTS')
          throw error;
        throw throwBadRequestError(getOrchestratorErrorMessage(error));
      }

      // Prompt is used as-is — enhancement happens client-side via enhancePromptText
      const fullPrompt = input.prompt;

      // Optionally include a referenced panel's image in generation
      const allImages = [...combinedRefImages];
      let referencePanelImageUrl: string | null = null;
      if (input.referencePanelId) {
        const refPanel = await dbRead.comicPanel.findUnique({
          where: { id: input.referencePanelId },
          include: { chapter: { select: { projectId: true } } },
        });
        if (!refPanel || refPanel.chapter.projectId !== input.projectId) {
          throw throwBadRequestError('Reference panel not found or not in this project');
        }
        if (refPanel.status !== ComicPanelStatus.Ready || !refPanel.imageUrl) {
          throw throwBadRequestError('Reference panel must be ready with an image');
        }
        referencePanelImageUrl = refPanel.imageUrl;
        const refEdgeUrl = getEdgeUrl(refPanel.imageUrl, { original: true });
        allImages.push({ url: refEdgeUrl, width: panelWidth, height: panelHeight });
      }

      // Include layout reference image if provided
      if (input.layoutImagePath) {
        const layoutUrl = `${env.NEXTAUTH_URL}${input.layoutImagePath}`;
        allImages.push({ url: layoutUrl, width: panelWidth, height: panelHeight });
      }

      // Build metadata for debugging and regeneration
      const metadata: Record<string, any> = {
        previousPanelId: effectiveContext?.id ?? null,
        previousPanelPrompt: effectiveContext
          ? effectiveContext.enhancedPrompt ?? effectiveContext.prompt
          : null,
        previousPanelImageUrl: contextPanel?.imageUrl ?? null,
        referenceImages: combinedRefImages,
        selectedImageIds: input.selectedImageIds ?? null,
        useContext: input.useContext,
        referencePanelId: input.referencePanelId ?? null,
        referencePanelImageUrl,
        layoutImagePath: input.layoutImagePath ?? null,
        enhanceEnabled: false,
        primaryReferenceName,
        allReferenceNames,
        quantity: input.quantity,
        generationParams: {
          engine: modelConfig.engine,
          baseModel: modelConfig.baseModel,
          checkpointVersionId: modelConfig.versionId,
          width: panelWidth,
          height: panelHeight,
          prompt: fullPrompt,
          negativePrompt: '',
        },
      };

      // Create panel record as Pending (not yet submitted to orchestrator)
      const panel = await dbWrite.comicPanel.create({
        data: {
          projectId: input.projectId,
          chapterPosition: input.chapterPosition,
          prompt: input.prompt,
          enhancedPrompt: null,
          position: nextPosition,
          status: ComicPanelStatus.Pending,
          metadata,
        },
      });

      // Insert into junction table — only for explicitly mentioned references
      if (mentionedReferenceIds.length > 0) {
        await dbWrite.comicPanelReference.createMany({
          data: mentionedReferenceIds.map((referenceId) => ({ panelId: panel.id, referenceId })),
          skipDuplicates: true,
        });
      }

      // Submit generation workflow
      try {
        const result = await submitComicGeneration({
          prompt: fullPrompt,
          width: panelWidth,
          height: panelHeight,
          aspectRatio: input.aspectRatio,
          quantity: input.quantity,
          images: allImages,
          modelConfig,
          user: ctx.user! as SessionUser,
          token,
          features: ctx.features,
          isGreen: ctx.features.isGreen,
          allowMatureContent: ctx.domain === 'green' ? false : undefined,
          track: ctx.track,
        });

        // Atomically set status to Generating and store workflow ID
        const updated = await dbWrite.comicPanel.update({
          where: { id: panel.id },
          data: { workflowId: result.id, status: ComicPanelStatus.Generating },
        });
        sendComicPanelSignal(ctx.user!.id, {
          panelId: updated.id,
          projectId: input.projectId,
          status: updated.status,
          workflowId: result.id,
        });
        return { ...(await panelForViewer(updated, null, ctx)), referenceImagesSkipped };
      } catch (error: any) {
        // Capture as much detail as possible for debugging
        const errorDetails: string[] = [];
        if (error instanceof Error) {
          errorDetails.push(error.message);
          if (error.cause) errorDetails.push(`Cause: ${JSON.stringify(error.cause)}`);
        } else {
          errorDetails.push(String(error));
        }
        // Orchestrator errors often have response data
        if (error?.response?.data) {
          errorDetails.push(`Response: ${JSON.stringify(error.response.data)}`);
        }
        if (error?.data) {
          errorDetails.push(`Data: ${JSON.stringify(error.data)}`);
        }

        const rawErrorMessage = errorDetails.join(' | ');
        console.error('Comics createPanel generation failed:', {
          panelId: panel.id,
          error: rawErrorMessage,
          stack: error instanceof Error ? error.stack : undefined,
        });

        // Store a user-friendly message on the panel while keeping full details in logs
        const userFacingError = getOrchestratorErrorMessage(error);
        const updated = await dbWrite.comicPanel.update({
          where: { id: panel.id },
          data: {
            status: ComicPanelStatus.Failed,
            errorMessage: userFacingError,
          },
        });
        return { ...(await panelForViewer(updated, null, ctx)), referenceImagesSkipped: false };
      }
    }),

  updatePanel: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(updatePanelSchema)
    .mutation(async ({ ctx, input }) => {
      // Verify ownership via chapter -> project
      // primary: the image url check below compares against the value about to be overwritten.
      const panel = await dbWrite.comicPanel.findUnique({
        where: { id: input.panelId },
        include: { chapter: { include: { project: { select: { userId: true } } } } },
      });

      if (!panel || panel.chapter.project.userId !== ctx.user.id) {
        throw throwAuthorizationError();
      }
      if (input.imageUrl != null && input.imageUrl !== panel.imageUrl) {
        throw throwBadRequestError('A panel image is changed through replacePanelImage');
      }

      const { image, ...updated } = await dbWrite.comicPanel.update({
        where: { id: input.panelId },
        data: {
          status: input.status,
          // Only clearing is written; any other value is the current one.
          imageUrl: input.imageUrl === null ? null : undefined,
        },
        include: { image: { select: panelImageVisibilitySelect } },
      });

      return panelForViewer(updated, image, ctx);
    }),

  replacePanelImage: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(z.object({ panelId: z.number().int(), imageUrl: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      // primary: a lagging replica would show a just-saved image as changed and refuse it.
      const panel = await dbWrite.comicPanel.findUnique({
        where: { id: input.panelId },
        include: {
          chapter: { include: { project: { select: { userId: true, id: true } } } },
          image: { select: { url: true, ...panelImageVisibilitySelect } },
        },
      });
      if (!panel || panel.chapter.project.userId !== ctx.user.id) {
        throw throwAuthorizationError();
      }
      const { chapter: _chapter, image: linked, ...stored } = panel;
      const unchanged =
        input.imageUrl === panel.imageUrl &&
        (!isBareUploadKey(input.imageUrl) || linked?.url === input.imageUrl);
      if (unchanged) return panelForViewer(stored, linked, ctx);
      assertBareUploadKeys([input.imageUrl]);

      const image = await createImage({
        url: input.imageUrl,
        type: 'image',
        clientUrl: true,
        userId: ctx.user.id,
      });

      const updated = await dbWrite.comicPanel.update({
        where: { id: input.panelId },
        data: { imageUrl: input.imageUrl, imageId: image.id },
      });

      // Trigger NSFW scanning and level recalculation
      ingestImageById({ id: image.id }).catch((e) =>
        console.error(`Failed to ingest sketch edit image ${image.id}:`, e)
      );
      updateComicNsfwLevels([panel.chapter.project.id]).catch(() => null);

      return panelForViewer(updated, null, ctx);
    }),

  deletePanel: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaDelete })
    .input(deletePanelSchema)
    .mutation(async ({ ctx, input }) => {
      // Verify ownership via chapter -> project
      const panel = await dbRead.comicPanel.findUnique({
        where: { id: input.panelId },
        include: { chapter: { include: { project: { select: { userId: true } } } } },
      });

      if (!panel || panel.chapter.project.userId !== ctx.user.id) {
        throw throwAuthorizationError();
      }
      // One statement: an unlock cannot claim the panel between the check and the delete.
      const deleted = await dbWrite.$queryRaw<{ id: number }[]>`
        DELETE FROM "ComicPanel" WHERE id = ${panel.id} AND NOT ${liveUnlockClaim()} RETURNING id
      `;
      if (!deleted.length) throw unlockStillFinishing();

      // Recalculate NSFW levels after panel removal
      await updateComicNsfwLevels([panel.projectId]).catch((e) =>
        console.error(`Failed to update NSFW levels after panel delete:`, e)
      );

      return { success: true };
    }),

  reorderPanels: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(reorderPanelsSchema)
    .use(isChapterOwner)
    .mutation(async ({ input }) => {
      // Verify all panels belong to this chapter
      const panels = await dbRead.comicPanel.findMany({
        where: { projectId: input.projectId, chapterPosition: input.chapterPosition },
        select: { id: true },
      });
      const chapterPanelIds = new Set(panels.map((p) => p.id));
      for (const id of input.panelIds) {
        if (!chapterPanelIds.has(id)) {
          throw throwBadRequestError('Panel does not belong to this chapter');
        }
      }

      // Update positions in a transaction
      await dbWrite.$transaction(
        input.panelIds.map((id, index) =>
          dbWrite.comicPanel.update({
            where: { id },
            data: { position: index },
          })
        )
      );

      return { success: true };
    }),

  // Debug info for a panel's generation workflow
  getPanelDebugInfo: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(z.object({ panelId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const panel = await dbRead.comicPanel.findUnique({
        where: { id: input.panelId },
        include: {
          chapter: {
            include: {
              project: { select: { userId: true, baseModel: true } },
            },
          },
          image: { select: panelImageVisibilitySelect },
          references: {
            include: {
              reference: {
                select: {
                  id: true,
                  name: true,
                  images: {
                    orderBy: { position: 'asc' },
                    include: { image: { select: referenceImageSelect } },
                  },
                },
              },
            },
          },
        },
      });

      if (!panel || panel.chapter.project.userId !== ctx.user!.id) {
        throw throwAuthorizationError();
      }

      // If panel has a workflowId and we can still check it, get orchestrator info
      let workflowInfo: any = null;
      if (panel.workflowId) {
        try {
          const token = await getOrchestratorToken(ctx.user!.id, ctx);
          const workflow = await getWorkflow({
            token,
            path: { workflowId: panel.workflowId },
          });
          workflowInfo = {
            id: workflow.id,
            status: workflow.status,
            createdAt: workflow.createdAt,
            completedAt: workflow.completedAt,
            cost: workflow.cost,
            tags: workflow.tags,
            steps: (workflow.steps ?? []).map((step: any) => ({
              name: step.name,
              status: step.status,
              $type: step.$type,
              completedAt: step.completedAt,
              hasOutput: !!step.output,
              outputImages: step.output?.images?.length ?? 0,
              outputBlobs: step.output?.blobs?.length ?? 0,
              queuePosition: step.queuePosition,
              estimatedProgressRate: step.estimatedProgressRate,
            })),
          };
        } catch (error: any) {
          workflowInfo = {
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      // Get reference images info from join table
      const panelReferences = panel.references.map((pr) => pr.reference);

      return {
        panel: {
          id: panel.id,
          status: panel.status,
          prompt: panel.prompt,
          enhancedPrompt: panel.enhancedPrompt,
          ...(await panelForViewer(
            { imageUrl: panel.imageUrl, metadata: panel.metadata },
            panel.image,
            ctx
          )),
          workflowId: panel.workflowId,
          errorMessage: panel.errorMessage,
          createdAt: panel.createdAt,
          updatedAt: panel.updatedAt,
        },
        project: {
          baseModel: panel.chapter.project.baseModel,
        },
        references: panelReferences.map((ref) => ({
          id: ref.id,
          name: ref.name,
          images: referenceForViewer(ref, ctx).images,
        })),
        generation: (() => {
          const mc = getComicModelConfig(panel.chapter.project.baseModel);
          return {
            engine: mc.engine,
            baseModel: mc.baseModel,
            checkpointVersionId: mc.versionId,
            dimensions: (panel.metadata as any)?.generationParams
              ? {
                  width: (panel.metadata as any).generationParams.width,
                  height: (panel.metadata as any).generationParams.height,
                }
              : {
                  width: getAspectRatioDimensions(DEFAULT_ASPECT_RATIO, mc).width,
                  height: getAspectRatioDimensions(DEFAULT_ASPECT_RATIO, mc).height,
                },
          };
        })(),
        workflow: workflowInfo,
      };
    }),

  // Poll panel generation status
  pollPanelStatus: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .input(z.object({ panelId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      // Use dbWrite for read-after-write consistency when polling after mutations
      const panel = await dbWrite.comicPanel.findUnique({
        where: { id: input.panelId },
        include: {
          chapter: { include: { project: { select: { userId: true } } } },
          image: { select: { ingestion: true, blockedFor: true } },
        },
      });

      if (!panel || panel.chapter.project.userId !== ctx.user!.id) {
        throw throwAuthorizationError();
      }
      const storedImageUrl =
        panel.image && !actsAsModerator(ctx) && !ownerMediaAllowed(panel.image)
          ? null
          : panel.imageUrl;

      // Only poll if panel is actively generating with a workflow.
      //
      // Two non-terminal states are allowed through:
      //  * `RequireUnlock` — owner needs to spend yellow Buzz to unlock a
      //    single-image generation. Re-polling refreshes the transient
      //    blurred-preview URL (the URL itself is ephemeral and never
      //    persisted).
      //  * `AwaitingSelection` with at least one locked candidate — multi-
      //    image generation where some candidates are mature. Re-polling
      //    keeps the locked candidates' blurred previews fresh AND, after
      //    the owner unlocks the workflow, picks up the now-clean URLs and
      //    backfills S3 keys for previously-locked candidate slots.
      const persistedCandidates = ((panel.metadata as any)?.candidateImages ?? []) as Array<
        { key: string } | { requiresUnlock: true; blockedReason: string }
      >;
      const hasLockedCandidate = persistedCandidates.some(
        (c) => c && (c as any).requiresUnlock === true
      );
      const panelBlockedReason = (panel.metadata as any)?.blockedReason as string | undefined;
      if (
        !panel.workflowId ||
        panel.status === ComicPanelStatus.Ready ||
        panel.status === ComicPanelStatus.Failed ||
        (panel.status === ComicPanelStatus.AwaitingSelection && !hasLockedCandidate)
      ) {
        return {
          id: panel.id,
          status: panel.status,
          imageUrl: storedImageUrl,
          errorMessage: panel.errorMessage,
        };
      }

      // Check orchestrator status
      try {
        const token = await getOrchestratorToken(ctx.user!.id, ctx);
        const workflow = await getWorkflow({
          token,
          path: { workflowId: panel.workflowId },
        });

        // Run the workflow through the same `formatGenerationResponse2` →
        // `WorkflowData` pipeline that the queue and the iterative editor
        // use. The orchestrator does NOT hand us a final
        // `blockedReason: 'canUpgrade' | 'siteRestricted'` — those are
        // *derived* in `BlobData`'s constructor from the output's
        // `nsfwLevel` plus the (domain, allowMatureContent)
        // context. Reading raw `step.output.images[i].blockedReason`
        // misses the derived path, so mature outputs slipped through and
        // we'd download the blurred preview as if it were a clean image.
        const [normalized] = await formatGenerationResponse2([workflow as any], ctx.user);
        const domainFlags: Record<ColorDomain, boolean> = colorDomainNames.reduce(
          (acc, c) => ({ ...acc, [c]: false }),
          {} as Record<ColorDomain, boolean>
        );
        domainFlags[ctx.domain as ColorDomain] = true;
        const wfData = new WorkflowData(normalized as any, {
          domain: domainFlags,
          holdUnrated: true,
        });
        const firstStep = wfData.steps[0];
        const rawOutputs = firstStep?.output ?? [];
        const imageUrl = rawOutputs[0]?.url ?? null;

        // Succeeded can precede the rating; hold the panel until it lands, since Ready is never
        // re-checked.
        if (workflow.status === 'succeeded' && rawOutputs.some((o) => o.pendingRating)) {
          return {
            id: panel.id,
            status: panel.status,
            imageUrl: storedImageUrl,
            errorMessage: panel.errorMessage,
          };
        }
        // SFW-domain mature output: the orchestrator returns a blurred
        // preview URL alongside a `blockedReason` (e.g. `canUpgrade`,
        // `siteRestricted`). Persisting that URL as `panel.imageUrl` (or as
        // a candidate S3 key) would both lock the user out of their
        // generation AND expose the CDN link through any surface that reads
        // it. So we don't.
        //
        // For single-image: drop the panel into `RequireUnlock`.
        // For multi-image: process each candidate independently — clean
        // ones get downloaded to S3 as before, blocked ones become
        // `{ requiresUnlock: true, blockedReason }` markers in metadata
        // (no URL persisted). The picker then lets the owner pick a clean
        // candidate OR unlock the workflow to recover blocked candidates.
        // The orchestrator's ephemeral preview URLs are returned only via
        // the poll response, never through anything persisted.
        const panelQuantity = (panel.metadata as any)?.quantity ?? 1;
        const isMultiImage = panelQuantity > 1 && rawOutputs.length > 1;

        // ---- Multi-image: per-candidate clean/locked split ----
        if (workflow.status === 'succeeded' && isMultiImage) {
          const genParams = (panel.metadata as any)?.generationParams;
          const imgWidth = genParams?.width ?? getAspectRatioDimensions(DEFAULT_ASPECT_RATIO).width;
          const imgHeight =
            genParams?.height ?? getAspectRatioDimensions(DEFAULT_ASPECT_RATIO).height;
          void imgWidth; // dimensions captured at selection time, not here
          void imgHeight;

          // Preserve any S3 keys we already downloaded for this index in a
          // prior poll — important so unlocking only re-downloads the
          // newly-clean candidates rather than re-uploading the whole batch.
          const previousByIndex = persistedCandidates;
          const newCandidates: Array<
            | { key: string; nsfwLevel?: number }
            | { requiresUnlock: true; blockedReason: string; nsfwLevel?: number }
          > = [];
          // Per-index transient blurred preview URLs returned to the owner
          // through the poll response only.
          const blurredPreviews: Array<string | null> = [];
          const {
            s3: s3Multi,
            bucket: multiBucket,
            backend: multiBackend,
          } = await getImageUploadBackend();

          for (let i = 0; i < rawOutputs.length; i++) {
            const candidateImg = rawOutputs[i];
            // Capture the orchestrator-derived nsfwLevel per slot so the
            // picker can blur mature candidates by default. Without this,
            // mature outputs that aren't `blockedReason`'d (e.g. on red with
            // allowMatureContent) flow to the picker uncensored.
            const nsfwLevel = normalizeCandidateNsfwLevel((candidateImg as any)?.nsfwLevel);

            // Locked candidate: marker only. The orchestrator MAY provide a
            // blurred preview URL (we forward it transiently in the response)
            // or omit the URL entirely (`available: false`) — either way we
            // never persist it.
            if (candidateImg?.blockedReason) {
              newCandidates.push({
                requiresUnlock: true,
                blockedReason: candidateImg.blockedReason as string,
                ...(nsfwLevel != null ? { nsfwLevel } : {}),
              });
              blurredPreviews.push(
                typeof candidateImg.url === 'string' && candidateImg.url
                  ? (candidateImg.url as string)
                  : null
              );
              continue;
            }

            if (!candidateImg?.url) {
              blurredPreviews.push(null);
              continue;
            }

            // Clean candidate: reuse existing S3 key if we already downloaded
            // this slot in a prior poll.
            const prev = previousByIndex[i] as any;
            if (prev && typeof prev.key === 'string') {
              newCandidates.push({
                key: prev.key,
                ...(typeof prev.nsfwLevel === 'number'
                  ? { nsfwLevel: prev.nsfwLevel }
                  : nsfwLevel != null
                  ? { nsfwLevel }
                  : {}),
              });
              blurredPreviews.push(null);
              continue;
            }

            try {
              const resp = await fetch(candidateImg.url, { signal: fetchTimeoutSignal(120_000) });
              if (!resp.ok) {
                blurredPreviews.push(null);
                continue;
              }
              const buf = Buffer.from(await resp.arrayBuffer());
              const s3Key = randomUUID();
              await s3Multi.send(
                new PutObjectCommand({
                  Bucket: multiBucket,
                  Key: s3Key,
                  Body: buf,
                  ContentType: resp.headers.get('content-type') || 'image/jpeg',
                })
              );
              registerMediaLocation(s3Key, multiBackend, buf.length);
              await recordMintedUploadKey(s3Key, ctx.user!.id, ctx.track);
              newCandidates.push({
                key: s3Key,
                ...(nsfwLevel != null ? { nsfwLevel } : {}),
              });
              blurredPreviews.push(null);
            } catch (e) {
              console.error(`Failed to upload candidate image for panel ${panel.id}:`, e);
              blurredPreviews.push(null);
            }
          }

          if (newCandidates.length === 0) {
            const failed = await dbWrite.comicPanel.update({
              where: { id: panel.id },
              data: {
                status: ComicPanelStatus.Failed,
                errorMessage: 'Failed to download generated images. Please regenerate.',
              },
            });
            sendComicPanelSignal(ctx.user!.id, {
              panelId: failed.id,
              projectId: panel.projectId,
              status: failed.status,
            });
            return {
              id: failed.id,
              status: failed.status,
              imageUrl: null,
              errorMessage: failed.errorMessage,
            };
          }

          // Idempotent persist: only write when the candidate set or status
          // actually changes. Subsequent polls just refresh the transient
          // preview URLs for any still-locked entries.
          const metadataChanged = JSON.stringify(previousByIndex) !== JSON.stringify(newCandidates);
          if (metadataChanged || panel.status !== ComicPanelStatus.AwaitingSelection) {
            await writePolledPanel(panel.id, {
              status: ComicPanelStatus.AwaitingSelection,
              metadata: { ...((panel.metadata as any) ?? {}), candidateImages: newCandidates },
            });
            sendComicPanelSignal(ctx.user!.id, {
              panelId: panel.id,
              projectId: panel.projectId,
              status: ComicPanelStatus.AwaitingSelection,
            });
          }

          return {
            id: panel.id,
            status: ComicPanelStatus.AwaitingSelection,
            imageUrl: storedImageUrl,
            // Per-candidate detail. Each entry corresponds to one orchestrator
            // output slot, in stable order. Locked entries carry the
            // ephemeral blurred URL for the owner's editor session only.
            candidates: newCandidates.map((c, i) =>
              'requiresUnlock' in c
                ? {
                    requiresUnlock: true as const,
                    blockedReason: c.blockedReason,
                    blurredPreviewUrl: blurredPreviews[i] ?? null,
                    nsfwLevel: c.nsfwLevel ?? null,
                  }
                : { key: c.key, nsfwLevel: c.nsfwLevel ?? null }
            ),
            // Backward-compat for any caller still reading the flat string
            // array — only includes clean (downloaded) candidates.
            candidateImages: newCandidates
              .filter((c): c is { key: string; nsfwLevel?: number } => 'key' in c)
              .map((c) => c.key),
            workflowId: panel.workflowId,
          };
        }

        // ---- Single-image RequireUnlock ----
        const blockedOutput = rawOutputs.find((o) => o?.blockedReason);
        const blockedReason = blockedOutput?.blockedReason as string | undefined;
        if (workflow.status === 'succeeded' && blockedReason) {
          const errorMessage = blockedReasonMessage(blockedReason);

          if (
            panel.status !== ComicPanelStatus.RequireUnlock ||
            panelBlockedReason !== blockedReason
          ) {
            await writePolledPanel(panel.id, {
              status: ComicPanelStatus.RequireUnlock,
              errorMessage,
              metadata: { ...((panel.metadata as any) ?? {}), blockedReason },
            });
            sendComicPanelSignal(ctx.user!.id, {
              panelId: panel.id,
              projectId: panel.projectId,
              status: ComicPanelStatus.RequireUnlock,
            });
          }

          return {
            id: panel.id,
            status: ComicPanelStatus.RequireUnlock,
            imageUrl: null,
            errorMessage,
            blockedReason,
            blurredPreviewUrl: (blockedOutput?.url as string | undefined) ?? null,
            workflowId: panel.workflowId,
          };
        }

        // Only download the image once the workflow has fully succeeded.
        // The URL can appear in step output before the image is actually available,
        // causing 404 errors if we try to fetch it too early.
        if (workflow.status === 'succeeded' && imageUrl) {
          // Extract dimensions from panel metadata (set during creation)
          const genParams = (panel.metadata as any)?.generationParams;
          const imgWidth = genParams?.width ?? getAspectRatioDimensions(DEFAULT_ASPECT_RATIO).width;
          const imgHeight =
            genParams?.height ?? getAspectRatioDimensions(DEFAULT_ASPECT_RATIO).height;

          // Single-image path (or multi-image with only 1 result)
          let s3ImageKey: string;
          try {
            const imageResponse = await fetch(imageUrl, { signal: fetchTimeoutSignal(120_000) });
            if (!imageResponse.ok) throw new Error(`Failed to download: ${imageResponse.status}`);
            const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

            s3ImageKey = randomUUID();
            const {
              s3: s3Single,
              bucket: singleBucket,
              backend: singleBackend,
            } = await getImageUploadBackend();
            await s3Single.send(
              new PutObjectCommand({
                Bucket: singleBucket,
                Key: s3ImageKey,
                Body: imageBuffer,
                ContentType: imageResponse.headers.get('content-type') || 'image/jpeg',
              })
            );
            registerMediaLocation(s3ImageKey, singleBackend, imageBuffer.length);
            await recordMintedUploadKey(s3ImageKey, ctx.user!.id, ctx.track);
          } catch (e) {
            console.error(`Failed to upload panel ${panel.id} image to S3:`, e);
            await dbWrite.comicPanel.update({
              where: { id: panel.id },
              data: {
                status: ComicPanelStatus.Failed,
                errorMessage: 'Image upload failed. Please regenerate.',
              },
            });
            sendComicPanelSignal(ctx.user!.id, {
              panelId: panel.id,
              projectId: panel.projectId,
              status: ComicPanelStatus.Failed,
            });
            return {
              id: panel.id,
              status: ComicPanelStatus.Failed,
              imageUrl: null,
              errorMessage: 'Image upload failed. Please regenerate.',
            };
          }

          // Create Image record via standard pipeline (ingestion + flags).
          // Pull `civitaiResources` straight off the workflow's step so the
          // Image carries the exact resources the orchestrator ran (checkpoint
          // + any LoRAs / additional networks), then let `createImageResources`
          // materialize the ImageResourceNew rows from that meta.
          const civitaiResources = (firstStep?.resources ?? []).map((r) => ({
            modelVersionId: r.id,
            type: r.model.type,
            weight: r.strength,
          }));
          const image = await createImage({
            url: s3ImageKey,
            type: 'image',
            userId: ctx.user!.id,
            width: imgWidth,
            height: imgHeight,
            meta: { prompt: panel.prompt, civitaiResources } as any,
          });
          await createImageResources({ imageId: image.id }).catch((e) =>
            console.error(`Failed to materialize resources for panel image ${image.id}:`, e)
          );

          const updated = await dbWrite.comicPanel.update({
            where: { id: panel.id },
            data: {
              status: ComicPanelStatus.Ready,
              imageUrl: s3ImageKey,
              imageId: image.id,
            },
          });

          sendComicPanelSignal(ctx.user!.id, {
            panelId: updated.id,
            projectId: panel.projectId,
            status: updated.status,
            imageUrl: updated.imageUrl,
          });

          return {
            id: updated.id,
            status: updated.status,
            imageUrl: updated.imageUrl,
            errorMessage: null,
          };
        }

        if (workflow.status === 'succeeded' && !imageUrl) {
          console.warn(
            `Panel ${panel.id}: workflow succeeded but no image URL found in step output`,
            JSON.stringify(firstStep?.output ?? null)
          );
          const updated = await dbWrite.comicPanel.update({
            where: { id: panel.id },
            data: { status: ComicPanelStatus.Ready },
          });
          sendComicPanelSignal(ctx.user!.id, {
            panelId: updated.id,
            projectId: panel.projectId,
            status: updated.status,
            imageUrl: updated.imageUrl,
          });
          return {
            id: updated.id,
            status: updated.status,
            imageUrl: updated.imageUrl,
            errorMessage: null,
          };
        }

        // `expired` is terminal too — every other surface already treats it that way.
        if (
          workflow.status === 'failed' ||
          workflow.status === 'canceled' ||
          workflow.status === 'expired'
        ) {
          const updated = await dbWrite.comicPanel.update({
            where: { id: panel.id },
            data: {
              status: ComicPanelStatus.Failed,
              errorMessage: `Generation ${workflow.status} — buzz has been refunded`,
            },
          });
          sendComicPanelSignal(ctx.user!.id, {
            panelId: updated.id,
            projectId: panel.projectId,
            status: updated.status,
          });
          return {
            id: updated.id,
            status: updated.status,
            imageUrl: updated.imageUrl,
            errorMessage: updated.errorMessage,
          };
        }
      } catch (error) {
        // A workflow the orchestrator no longer has is never coming back, and this poll is the only
        // thing that can say so — otherwise the panel spins on every page view for good.
        if ((error as { code?: string })?.code === 'NOT_FOUND') {
          const updated = await dbWrite.comicPanel.update({
            where: { id: panel.id },
            data: {
              status: ComicPanelStatus.Failed,
              errorMessage: 'Generation is no longer available',
            },
          });
          sendComicPanelSignal(ctx.user!.id, {
            panelId: updated.id,
            projectId: panel.projectId,
            status: updated.status,
          });
          return {
            id: updated.id,
            status: updated.status,
            imageUrl: updated.imageUrl,
            errorMessage: updated.errorMessage,
          };
        }
        // Any other read failure is transient — don't fail the poll, just return current state.
        console.error('Failed to poll workflow status:', error);
      }

      // Still processing - return as-is
      return {
        id: panel.id,
        status: panel.status,
        imageUrl: storedImageUrl,
        errorMessage: panel.errorMessage,
      };
    }),

  // Lift the SFW-domain mature-content restriction on a single panel's
  // workflow (yellow-Buzz unlock). Mirrors the QueueItem CanUpgradeBlock
  // flow: hand `allowMatureContent: true` to the orchestrator, which charges
  // the difference in yellow Buzz, then reset the panel to `Generating` so
  // the existing poll loop downloads the now-unblocked image.
  unlockPanelGeneration: comicGenerationProcedure
    .input(z.object({ panelId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      // primary: the stored candidates route the unlock; a lagging replica can miss them.
      const panel = await dbWrite.comicPanel.findUnique({
        where: { id: input.panelId },
        include: { chapter: { include: { project: { select: { userId: true } } } } },
      });
      if (!panel || panel.chapter.project.userId !== ctx.user!.id) {
        throw throwAuthorizationError();
      }
      if (!panel.workflowId) {
        throw throwBadRequestError('Panel has no workflow to unlock.');
      }

      assertUnlockAllowed({ domain: ctx.domain });

      // Deliberately no gate on `panel.status` or `metadata.blockedReason`: the poll loop writes them,
      // so they can be stale or missing on legacy panels. The orchestrator's workflow is the authority.
      // The writes that end this unlock start from this copy; a claim in it is another request's (or
      // expired) and is not this one's to write back.
      const meta = { ...((panel.metadata as any) ?? {}) };
      delete meta.unlockClaim;
      const candidates: Array<{ key?: string; requiresUnlock?: boolean; blockedReason?: string }> =
        meta.candidateImages ?? [];
      // Only a multi-image generation stores candidates; a selection leaves them stored and the
      // panel Ready, so the status cannot tell the two apart.
      const isSinglePanelBlocked = candidates.length === 0;

      // Lift the mature restriction at the orchestrator. It charges yellow Buzz even when the
      // workflow's cap leaves nothing to release, so the cap check runs before the write.
      let token: string;
      try {
        token = await getOrchestratorToken(ctx.user!.id, ctx);
      } catch (error) {
        throw throwBadRequestError(getOrchestratorErrorMessage(error));
      }
      // Already unlocked with slots still locked here (an earlier unlock that did not reach them), or
      // a single-image panel whose unlock was paid but not collected: collect without a new charge.
      const alreadyPaid =
        (candidates.some((c) => c?.requiresUnlock === true) ||
          (isSinglePanelBlocked && panel.status !== ComicPanelStatus.Ready)) &&
        (await getWorkflow({ token, path: { workflowId: panel.workflowId } }))
          .allowMatureContent === true;
      let claim: string | null = null;
      // A charge write that failed without a refusal (cut off by its bound, a gateway error) may
      // still land: the claim then stays until it expires.
      let chargeMayLand = false;
      try {
        if (!alreadyPaid) {
          claim = await claimPanelUnlock(panel.id);
          if (!claim) throw throwBadRequestError('This panel is already being unlocked.');
          await assertUnlockReleasesOutput({ token, workflowId: panel.workflowId });
          const bound = new AbortController();
          const timer = setTimeout(() => bound.abort(), UNLOCK_CHARGE_TIMEOUT_MS);
          try {
            // The mapped error keeps the orchestrator's own message (insufficient Buzz, the cap).
            await updateWorkflow({
              token,
              workflowId: panel.workflowId,
              allowMatureContent: true,
              throwOnError: true,
              signal: bound.signal,
            });
          } catch (error) {
            if (!bound.signal.aborted && !chargeOutcomeUnknown(error)) throw error;
            chargeMayLand = true;
            throw throwBadRequestError(
              'This unlock is not confirmed yet. Check this panel again in a few minutes.'
            );
          } finally {
            clearTimeout(timer);
          }
        }

        // Same BlobData pipeline as pollPanelStatus, inline so Unlock returns the final state in one round-trip.
        const fresh = await getWorkflow({ token, path: { workflowId: panel.workflowId } });
        const [normalized] = await formatGenerationResponse2([fresh as any], ctx.user);
        const domainFlags: Record<ColorDomain, boolean> = colorDomainNames.reduce(
          (acc, c) => ({ ...acc, [c]: false }),
          {} as Record<ColorDomain, boolean>
        );
        domainFlags[ctx.domain as ColorDomain] = true;
        const wfData = new WorkflowData(normalized as any, {
          domain: domainFlags,
          holdUnrated: true,
        });
        const firstStep = wfData.steps[0];
        const outputs = firstStep?.output ?? [];

        // Single-image: download the now-clean URL into S3 and mark Ready.
        if (isSinglePanelBlocked) {
          const clean = outputs.find((o) => !o.blockedReason && o.url);
          if (!clean?.url) {
            // Orchestrator hasn't propagated the unblocked output yet, or the
            // unlock didn't actually clear the block (e.g. POI/minor flag).
            // Drop back to `Generating` so the regular poll loop picks it up
            // when it does become available.
            const { blockedReason: _drop, ...metaWithoutBlock } = meta;
            const updated = await dbWrite.comicPanel.update({
              where: { id: panel.id },
              data: {
                status: ComicPanelStatus.Generating,
                errorMessage: null,
                metadata: metaWithoutBlock,
              },
            });
            sendComicPanelSignal(ctx.user!.id, {
              panelId: updated.id,
              projectId: panel.projectId,
              status: updated.status,
            });
            return {
              id: updated.id,
              status: updated.status,
              imageUrl: null,
              candidateImages: [] as string[],
            };
          }

          const genParams = meta?.generationParams;
          const imgWidth = genParams?.width ?? getAspectRatioDimensions(DEFAULT_ASPECT_RATIO).width;
          const imgHeight =
            genParams?.height ?? getAspectRatioDimensions(DEFAULT_ASPECT_RATIO).height;

          let s3Key: string;
          try {
            const resp = await fetch(clean.url, { signal: fetchTimeoutSignal(120_000) });
            if (!resp.ok) throw new Error(`Failed to download: ${resp.status}`);
            const buf = Buffer.from(await resp.arrayBuffer());
            s3Key = randomUUID();
            const { s3, bucket, backend } = await getImageUploadBackend();
            await s3.send(
              new PutObjectCommand({
                Bucket: bucket,
                Key: s3Key,
                Body: buf,
                ContentType: resp.headers.get('content-type') || 'image/jpeg',
              })
            );
            registerMediaLocation(s3Key, backend, buf.length);
            await recordMintedUploadKey(s3Key, ctx.user!.id, ctx.track);
          } catch (e) {
            console.error(`Failed to download unlocked panel ${panel.id}:`, e);
            throw throwBadRequestError('Unlock succeeded but image download failed. Please retry.');
          }

          const civitaiResources = (firstStep?.resources ?? []).map((r) => ({
            modelVersionId: r.id,
            type: r.model.type,
            weight: r.strength,
          }));
          const image = await createImage({
            url: s3Key,
            type: 'image',
            userId: ctx.user!.id,
            width: imgWidth,
            height: imgHeight,
            meta: { prompt: panel.prompt, civitaiResources } as any,
          });
          await createImageResources({ imageId: image.id }).catch((e) =>
            console.error(
              `Failed to materialize resources for unlocked panel image ${image.id}:`,
              e
            )
          );

          const { blockedReason: _drop, ...metaWithoutBlock } = meta;
          const updated = await dbWrite.comicPanel.update({
            where: { id: panel.id },
            data: {
              status: ComicPanelStatus.Ready,
              imageUrl: s3Key,
              imageId: image.id,
              errorMessage: null,
              metadata: metaWithoutBlock,
            },
          });
          sendComicPanelSignal(ctx.user!.id, {
            panelId: updated.id,
            projectId: panel.projectId,
            status: updated.status,
            imageUrl: updated.imageUrl,
          });
          return {
            id: updated.id,
            status: updated.status,
            imageUrl: updated.imageUrl,
            candidateImages: [] as string[],
          };
        }

        // Multi-image: replace each `requiresUnlock` slot with a freshly downloaded S3 key, in
        // stable orchestrator order. Already-clean slots keep their existing key (no re-upload).
        const previousByIndex = candidates;
        const newCandidates: Array<
          | { key: string; nsfwLevel?: number }
          | { requiresUnlock: true; blockedReason: string; nsfwLevel?: number }
        > = [];
        const {
          s3: s3Multi,
          bucket: multiBucket,
          backend: multiBackend,
        } = await getImageUploadBackend();

        for (let i = 0; i < outputs.length; i++) {
          const out = outputs[i];
          const prev = previousByIndex[i] as any;
          const slotNsfwLevel = normalizeCandidateNsfwLevel((out as any)?.nsfwLevel);

          if (prev && typeof prev.key === 'string') {
            newCandidates.push({
              key: prev.key,
              ...(typeof prev.nsfwLevel === 'number'
                ? { nsfwLevel: prev.nsfwLevel }
                : slotNsfwLevel != null
                ? { nsfwLevel: slotNsfwLevel }
                : {}),
            });
            continue;
          }

          if (!out?.url) {
            // Orchestrator still has nothing for this slot — keep it locked
            // so a subsequent poll can pick it up if/when it materializes.
            newCandidates.push({
              requiresUnlock: true,
              blockedReason: out?.blockedReason ?? 'canUpgrade',
              ...(slotNsfwLevel != null ? { nsfwLevel: slotNsfwLevel } : {}),
            });
            continue;
          }

          if (out.blockedReason) {
            // Still blocked even after the unlock (POI, minor, etc.). Keep
            // the marker so the picker doesn't render it as selectable.
            newCandidates.push({
              requiresUnlock: true,
              blockedReason: out.blockedReason,
              ...(slotNsfwLevel != null ? { nsfwLevel: slotNsfwLevel } : {}),
            });
            continue;
          }

          try {
            const resp = await fetch(out.url, { signal: fetchTimeoutSignal(120_000) });
            if (!resp.ok) {
              newCandidates.push({
                requiresUnlock: true,
                blockedReason: 'canUpgrade',
                ...(slotNsfwLevel != null ? { nsfwLevel: slotNsfwLevel } : {}),
              });
              continue;
            }
            const buf = Buffer.from(await resp.arrayBuffer());
            const s3Key = randomUUID();
            await s3Multi.send(
              new PutObjectCommand({
                Bucket: multiBucket,
                Key: s3Key,
                Body: buf,
                ContentType: resp.headers.get('content-type') || 'image/jpeg',
              })
            );
            registerMediaLocation(s3Key, multiBackend, buf.length);
            await recordMintedUploadKey(s3Key, ctx.user!.id, ctx.track);
            newCandidates.push({
              key: s3Key,
              ...(slotNsfwLevel != null ? { nsfwLevel: slotNsfwLevel } : {}),
            });
          } catch (e) {
            console.error(
              `Failed to download unlocked candidate for panel ${panel.id} slot ${i}:`,
              e
            );
            newCandidates.push({
              requiresUnlock: true,
              blockedReason: 'canUpgrade',
              ...(slotNsfwLevel != null ? { nsfwLevel: slotNsfwLevel } : {}),
            });
          }
        }

        // A selection stays selected: only the slots change.
        const keepsSelection = panel.status === ComicPanelStatus.Ready && !!panel.imageUrl;
        const updated = await dbWrite.comicPanel.update({
          where: { id: panel.id },
          data: {
            status: keepsSelection ? panel.status : ComicPanelStatus.AwaitingSelection,
            metadata: {
              ...meta,
              candidateImages: newCandidates,
            },
          },
        });
        sendComicPanelSignal(ctx.user!.id, {
          panelId: updated.id,
          projectId: panel.projectId,
          status: updated.status,
        });
        return {
          id: updated.id,
          status: updated.status,
          imageUrl: updated.imageUrl,
          // Per-slot detail with the orchestrator's nsfwLevel so the picker
          // can blur mature candidates by default. Locked entries lose any
          // ephemeral preview URL here — the unlock response shouldn't need
          // them since the workflow restriction was just lifted.
          candidates: newCandidates.map((c) =>
            'requiresUnlock' in c
              ? {
                  requiresUnlock: true as const,
                  blockedReason: c.blockedReason,
                  blurredPreviewUrl: null as string | null,
                  nsfwLevel: c.nsfwLevel ?? null,
                }
              : { key: c.key, nsfwLevel: c.nsfwLevel ?? null }
          ),
          candidateImages: newCandidates
            .filter((c): c is { key: string; nsfwLevel?: number } => 'key' in c)
            .map((c) => c.key),
        };
      } catch (error) {
        if (claim && !chargeMayLand)
          await releasePanelUnlock(panel.id, claim).catch(() => undefined);
        throw error;
      }
    }),

  selectPanelImage: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(
      z.object({
        panelId: z.number().int(),
        selectedImageKey: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const panel = await dbRead.comicPanel.findUnique({
        where: { id: input.panelId },
        include: { chapter: { include: { project: { select: { userId: true } } } } },
      });

      if (!panel || panel.chapter.project.userId !== ctx.user!.id) {
        throw throwAuthorizationError();
      }

      const meta = panel.metadata as any;
      const candidates: Array<{ key?: string; requiresUnlock?: boolean }> =
        meta?.candidateImages ?? [];
      // Only clean (downloaded) candidates carry a `key`. Locked candidates
      // are markers without a URL — they must be unlocked first via
      // `unlockPanelGeneration`, which re-runs the poll and downloads the
      // now-clean URL into a real key.
      if (!candidates.some((c) => typeof c.key === 'string' && c.key === input.selectedImageKey)) {
        throw throwBadRequestError(
          'Selected image is not among the available (unlocked) candidates'
        );
      }
      // primary: a block on an Image the key already backs must show up here, not after replica lag.
      const backing = await dbWrite.image.findMany({
        where: { url: input.selectedImageKey },
        select: { ingestion: true, blockedFor: true },
      });
      if (backing.some((row) => !ownerMediaAllowed(row)))
        throw throwBadRequestError('This image is blocked and cannot be selected.');

      const genParams = meta?.generationParams;
      const imgWidth = genParams?.width ?? getAspectRatioDimensions(DEFAULT_ASPECT_RATIO).width;
      const imgHeight = genParams?.height ?? getAspectRatioDimensions(DEFAULT_ASPECT_RATIO).height;

      // Pull the orchestrator's resources for the workflow that produced these
      // candidates so the Image we mint carries the actual checkpoint + any
      // additional networks. All candidates of a multi-image gen share one
      // workflow, so a single re-fetch covers whichever the user picked.
      let civitaiResources: Array<{ modelVersionId: number; type: string; weight?: number }> = [];
      if (panel.workflowId) {
        try {
          const token = await getOrchestratorToken(ctx.user!.id, ctx);
          const workflow = await getWorkflow({ token, path: { workflowId: panel.workflowId } });
          const [normalized] = await formatGenerationResponse2([workflow as any], ctx.user);
          const domainFlags: Record<ColorDomain, boolean> = colorDomainNames.reduce(
            (acc, c) => ({ ...acc, [c]: false }),
            {} as Record<ColorDomain, boolean>
          );
          domainFlags[ctx.domain as ColorDomain] = true;
          const wfData = new WorkflowData(normalized as any, {
            domain: domainFlags,
          });
          civitaiResources = (wfData.steps[0]?.resources ?? []).map((r) => ({
            modelVersionId: r.id,
            type: r.model.type,
            weight: r.strength,
          }));
        } catch (e) {
          console.error(`Failed to fetch workflow resources for panel ${panel.id}:`, e);
        }
      }

      // Create Image record for the selected candidate
      const image = await createImage({
        url: input.selectedImageKey,
        type: 'image',
        userId: ctx.user!.id,
        width: imgWidth,
        height: imgHeight,
        meta: { prompt: panel.prompt, civitaiResources } as any,
      });
      await createImageResources({ imageId: image.id }).catch((e) =>
        console.error(`Failed to materialize resources for selected panel image ${image.id}:`, e)
      );

      // Keep candidates in metadata so user can change selection later
      const updated = await dbWrite.comicPanel.update({
        where: { id: input.panelId },
        data: {
          status: ComicPanelStatus.Ready,
          imageUrl: input.selectedImageKey,
          imageId: image.id,
        },
      });

      sendComicPanelSignal(ctx.user!.id, {
        panelId: updated.id,
        projectId: panel.projectId,
        status: updated.status,
        imageUrl: updated.imageUrl,
      });

      return panelForViewer(updated, null, ctx);
    }),

  // Iterative panel editor — generate image without creating a panel record
  iterateGenerate: comicGenerationProcedure
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(iterateGenerateSchema)
    .use(isProjectOwner)
    .mutation(async ({ ctx, input }) => {
      // Verify project ownership and get baseModel
      const project = await dbRead.comicProject.findUnique({
        where: { id: input.projectId },
        select: { id: true, userId: true, baseModel: true },
      });
      if (!project || project.userId !== ctx.user!.id) {
        throw throwAuthorizationError();
      }
      await assertGenerationInputUrlsUsable({
        urls: [input.sourceImageUrl, ...(input.userReferenceImages ?? []).map((ref) => ref.url)],
        userId: ctx.user!.id,
      });

      const modelConfig = getComicModelConfig(input.baseModel ?? project.baseModel);
      const effectiveVersionId =
        input.sourceImageUrl && modelConfig.img2imgVersionId
          ? modelConfig.img2imgVersionId
          : modelConfig.versionId;
      const { width: panelWidth, height: panelHeight } = getAspectRatioDimensions(
        input.aspectRatio,
        modelConfig
      );

      // Get all user's ready references for prompt context and auto-detection
      const allUserRefs = await dbRead.comicReference.findMany({
        where: { userId: ctx.user!.id, status: ComicReferenceStatus.Ready },
        select: { id: true, name: true },
      });
      const allReferenceNames = allUserRefs.map((r) => r.name);

      // Resolve @mentions from prompt
      const { mentionedIds } = resolveReferenceMentions({
        prompt: input.prompt,
        references: allUserRefs,
      });
      const mentionedReferenceIds = mentionedIds;

      // Determine which references provide images for generation
      // Only include references that were explicitly @mentioned in the prompt
      // or explicitly passed via referenceIds — never auto-include all references
      const allowedRefIds = new Set(allUserRefs.map((r) => r.id));
      let generationReferenceIds: number[];
      if (input.referenceIds && input.referenceIds.length > 0) {
        if (input.referenceIds.some((id) => !allowedRefIds.has(id))) {
          throw throwAuthorizationError();
        }
        generationReferenceIds = input.referenceIds;
      } else {
        generationReferenceIds = mentionedReferenceIds;
      }

      // Gather reference images from selected refs
      let primaryReferenceName = '';
      let referenceImagesSkipped = false;
      const allRefImages: { imageId: number; url: string; width: number; height: number }[] = [];
      for (const refId of generationReferenceIds) {
        const { referenceName, refImages: imgs, skipped } = await getReferenceImages(refId);
        if (!primaryReferenceName && referenceName) primaryReferenceName = referenceName;
        if (skipped) referenceImagesSkipped = true;
        allRefImages.push(...imgs);
      }

      // Filter to user-selected images if specified
      const selectedImageIdSet =
        input.selectedImageIds && input.selectedImageIds.length > 0
          ? new Set(input.selectedImageIds)
          : null;
      const combinedRefImages = (
        selectedImageIdSet
          ? allRefImages.filter((img) => selectedImageIdSet.has(img.imageId))
          : allRefImages
      ).map(({ url, width, height }) => ({ url, width, height }));

      // Build images array: source image first (if img2img), then reference images
      const allImages: { url: string; width: number; height: number }[] = [];
      if (input.sourceImageUrl && input.sourceImageWidth && input.sourceImageHeight) {
        const sourceEdgeUrl = getEdgeUrl(input.sourceImageUrl, { original: true });
        allImages.push({
          url: sourceEdgeUrl,
          width: input.sourceImageWidth,
          height: input.sourceImageHeight,
        });
      }
      allImages.push(...combinedRefImages);

      // Add user-imported reference images (from PC or generator)
      if (input.userReferenceImages) {
        for (const ref of input.userReferenceImages) {
          const refEdgeUrl = getEdgeUrl(ref.url, { original: true });
          allImages.push({ url: refEdgeUrl, width: ref.width, height: ref.height });
        }
      }

      const token = await getOrchestratorToken(ctx.user!.id, ctx);

      // Enforce queue limits before generation
      await assertCanGenerate(token, ctx.user?.tier ?? 'free', 1);

      // Build prompt — optionally enhance
      const mentionedRefIdSet = new Set(mentionedReferenceIds);
      const mentionedNames = allUserRefs
        .filter((r) => mentionedRefIdSet.has(r.id))
        .map((r) => r.name);

      // Prompt is used as-is — enhancement happens client-side via enhancePromptText
      const fullPrompt = input.prompt.trim();

      const result = await submitComicGeneration({
        prompt: fullPrompt || '',
        width: panelWidth,
        height: panelHeight,
        aspectRatio: input.aspectRatio,
        quantity: input.quantity,
        images: allImages,
        modelConfig,
        versionIdOverride: effectiveVersionId,
        user: ctx.user! as SessionUser,
        token,
        features: ctx.features,
        isGreen: ctx.features.isGreen,
        allowMatureContent: ctx.domain === 'green' ? false : undefined,
        track: ctx.track,
      });

      return {
        workflowId: result.id,
        width: panelWidth,
        height: panelHeight,
        cost: result.cost?.total ?? 0,
        referenceImagesSkipped,
        enhancedPrompt: null,
      };
    }),

  // Iterative panel editor — poll workflow status without panel involvement
  generateComicImage: comicGenerationProcedure
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(
      z.object({
        prompt: z.string().min(1).max(2000),
        aspectRatio: z.string().default('3:4'),
        baseModel: z.string().optional(),
        quantity: z.number().int().min(1).max(4).default(1),
        userReferenceImages: z
          .array(z.object({ url: z.string(), width: z.number(), height: z.number() }))
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertGenerationInputUrlsUsable({
        urls: (input.userReferenceImages ?? []).map((ref) => ref.url),
        userId: ctx.user!.id,
      });
      const token = await getOrchestratorToken(ctx.user!.id, ctx).catch((error) => {
        throw throwBadRequestError(getOrchestratorErrorMessage(error));
      });

      const modelConfig = getComicModelConfig(input.baseModel);
      const { width, height } = getAspectRatioDimensions(input.aspectRatio, modelConfig);

      // Build reference images array from user uploads
      const images = input.userReferenceImages?.map((ref) => ({
        url: getEdgeUrl(ref.url, { original: true }),
        width: ref.width,
        height: ref.height,
      }));

      const result = await submitComicGeneration({
        prompt: input.prompt,
        width,
        height,
        aspectRatio: input.aspectRatio,
        quantity: input.quantity,
        images: images ?? null,
        modelConfig,
        user: ctx.user! as SessionUser,
        token,
        features: ctx.features,
        isGreen: ctx.features.isGreen,
        allowMatureContent: ctx.domain === 'green' ? false : undefined,
        track: ctx.track,
      });

      return {
        workflowId: result.id,
        width,
        height,
        cost: result.cost?.total ?? 0,
      };
    }),

  pollIterationStatus: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .input(
      z.object({
        workflowId: z.string().min(1),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        prompt: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      return pollIterationWorkflow({
        workflowId: input.workflowId,
        width: input.width,
        height: input.height,
        prompt: input.prompt,
        userId: ctx.user!.id,
        ctx,
      });
    }),

  // Smart Create — Plan chapter panels via GPT
  planChapterPanels: comicGenerationProcedure
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(planChapterPanelsSchema)
    .use(isProjectOwner)
    .mutation(async ({ ctx, input }) => {
      // The plan is a paid step toward panels the kill switch would refuse: refuse it first.
      await assertPresetGenerationAllowed(ctx.user! as SessionUser);
      let token: string;
      try {
        token = await getOrchestratorToken(ctx.user!.id, ctx);
      } catch (error) {
        throw throwBadRequestError(getOrchestratorErrorMessage(error));
      }

      // Get all user's references, then filter to only those @mentioned in the story
      const allUserRefs = await dbRead.comicReference.findMany({
        where: { userId: ctx.user!.id, status: ComicReferenceStatus.Ready },
        select: { id: true, name: true },
      });
      const { mentionedIds } = resolveReferenceMentions({
        prompt: input.storyDescription,
        references: allUserRefs,
      });
      const mentionedNames = allUserRefs
        .filter((r) => mentionedIds.includes(r.id))
        .map((r) => r.name);

      try {
        return await planChapterPanels({
          token,
          storyDescription: input.storyDescription,
          characterNames: mentionedNames,
          panelCount: input.panelCount ?? undefined,
          currencies: getAllowedAccountTypes(ctx.features, ['blue']),
        });
      } catch (error) {
        throw throwBadRequestError(getOrchestratorErrorMessage(error));
      }
    }),

  // Smart Create — Create chapter with all panels at once
  smartCreateChapter: comicGenerationProcedure
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(smartCreateChapterSchema)
    .use(isProjectOwner)
    .mutation(async ({ ctx, input }) => {
      await throwOnBlockedUserContent(input.chapterName, {
        isModerator: ctx.user?.isModerator,
        surface: 'comic',
      });
      // Every panel here is submitted now or queued for the job, so the kill switch refuses the
      // whole create up front rather than leaving a chapter of panels that fail later.
      await assertPresetGenerationAllowed(ctx.user! as SessionUser);
      // Check how many queue slots the user has available upfront.
      // Panels that fit will be submitted immediately; the rest get enqueued
      // for the background job to process when slots free up.
      let token: string;
      try {
        token = await getOrchestratorToken(ctx.user!.id, ctx);
      } catch (error) {
        throw throwBadRequestError(getOrchestratorErrorMessage(error));
      }

      const userTier = ctx.user?.tier ?? 'free';
      let remainingSlots: number;
      try {
        const queueStatus = await getUserQueueStatus(token, userTier);
        remainingSlots = queueStatus.canGenerate ? queueStatus.available : 0;
      } catch (error) {
        throw throwBadRequestError(getOrchestratorErrorMessage(error));
      }

      // Fetch project baseModel for generation config
      const project = await dbRead.comicProject.findUnique({
        where: { id: input.projectId },
        select: { baseModel: true },
      });
      const modelConfig = getComicModelConfig(input.baseModel ?? project?.baseModel);

      // Create the chapter
      const lastChapter = await dbRead.comicChapter.findFirst({
        where: { projectId: input.projectId },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      const nextPosition = (lastChapter?.position ?? -1) + 1;

      const chapter = await dbWrite.comicChapter.create({
        data: {
          projectId: input.projectId,
          name: input.chapterName,
          position: nextPosition,
        },
      });

      // Only use references scoped to this project (via junction table).
      // Then narrow further to those @-mentioned in the story or explicitly passed.
      const projectRefRows = await dbRead.comicProjectReference.findMany({
        where: { projectId: input.projectId },
        select: { referenceId: true },
      });
      const projectRefIds = new Set(projectRefRows.map((r) => r.referenceId));

      const projectRefs =
        projectRefIds.size > 0
          ? await dbRead.comicReference.findMany({
              where: {
                id: { in: Array.from(projectRefIds) },
                userId: ctx.user!.id,
                status: ComicReferenceStatus.Ready,
              },
              select: { id: true, name: true },
            })
          : [];

      // Validate explicitly passed referenceIds belong to this project
      if (input.referenceIds && input.referenceIds.some((id) => !projectRefIds.has(id))) {
        throw throwAuthorizationError();
      }

      // Filter to references that are either explicitly provided via referenceIds
      // or @-mentioned in the story description.
      const { mentionedIds: storyMentionedIds } = resolveReferenceMentions({
        prompt: input.storyDescription,
        references: projectRefs,
      });
      const relevantRefIds = new Set([...storyMentionedIds, ...(input.referenceIds ?? [])]);
      const relevantRefs = projectRefs.filter((r) => relevantRefIds.has(r.id));

      // Pre-load reference images keyed by refId (only used for panels that @mention them)
      const refImagesByRefId = new Map<
        number,
        {
          referenceName: string;
          images: { url: string; width: number; height: number }[];
          skipped: boolean;
        }
      >();
      let referenceImagesSkipped = false;
      for (const ref of relevantRefs) {
        const { referenceName, refImages: imgs, skipped } = await getReferenceImages(ref.id);
        refImagesByRefId.set(ref.id, {
          referenceName: referenceName ?? ref.name,
          images: imgs.map(({ url, width, height }) => ({ url, width, height })),
          skipped,
        });
      }

      // Create panels sequentially — each panel uses the previous as context
      // Build story context so the enhancer sees the full narrative arc
      const { width: smartWidth, height: smartHeight } = getAspectRatioDimensions(
        input.aspectRatio,
        modelConfig
      );
      const createdPanels: any[] = [];
      const previousPanelPrompts: string[] = [];
      let contextPanel: {
        id: number;
        prompt: string;
        enhancedPrompt: string | null;
        imageUrl: string | null;
      } | null = null;

      for (let i = 0; i < input.panels.length; i++) {
        const panelInput = input.panels[i];

        // Per-panel @mention auto-detection: only mentioned refs get their images included.
        // Use relevantRefs (scoped to this comic) instead of allUserRefs to prevent
        // cross-comic reference bleeding.
        const { mentionedIds } = resolveReferenceMentions({
          prompt: panelInput.prompt,
          references: relevantRefs,
        });
        const mentionedRefImages = mentionedIds.flatMap(
          (id) => refImagesByRefId.get(id)?.images ?? []
        );
        if (mentionedIds.some((id) => refImagesByRefId.get(id)?.skipped)) {
          referenceImagesSkipped = true;
        }
        const panelPrimaryRefName =
          mentionedIds.length > 0 ? refImagesByRefId.get(mentionedIds[0])?.referenceName ?? '' : '';
        const mentionedRefNames = mentionedIds
          .map((id) => refImagesByRefId.get(id)?.referenceName ?? '')
          .filter(Boolean);

        // Submit immediately if slots are available, otherwise enqueue for the job
        const shouldEnqueue = remainingSlots <= 0;
        const panel = await createSinglePanel({
          projectId: input.projectId,
          chapterPosition: chapter.position,
          referenceIds: mentionedIds,
          prompt: panelInput.prompt,
          position: i,
          contextPanel,
          allReferenceNames: mentionedRefNames,
          primaryReferenceName: panelPrimaryRefName,
          refImages: mentionedRefImages,
          userId: ctx.user!.id,
          ctx,
          width: smartWidth,
          height: smartHeight,
          aspectRatio: input.aspectRatio,
          modelConfig,
          storyContext: {
            storyDescription: input.storyDescription,
            previousPanelPrompts: [...previousPanelPrompts],
          },
          enqueue: shouldEnqueue,
        });
        if (!shouldEnqueue) remainingSlots--;

        createdPanels.push(panel);
        previousPanelPrompts.push(panel.enhancedPrompt ?? panelInput.prompt);

        // Use this panel as context for the next one
        contextPanel = {
          id: panel.id,
          prompt: panelInput.prompt,
          enhancedPrompt: panel.enhancedPrompt,
          imageUrl: panel.imageUrl,
        };
      }

      return {
        ...chapter,
        panels: await panelsForViewer(createdPanels, ctx),
        referenceImagesSkipped,
      };
    }),

  // ──── Phase 3: Publish/Unpublish ────

  publishChapter: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(
      z.object({
        projectId: z.number().int(),
        chapterPosition: z.number().int().min(0),
        earlyAccessConfig: chapterEarlyAccessConfigSchema.optional(),
        scheduledAt: z.date().optional(),
      })
    )
    .use(isChapterOwner)
    .mutation(async ({ ctx, input }) => {
      const chapter = await dbRead.comicChapter.findUnique({
        where: {
          projectId_position: { projectId: input.projectId, position: input.chapterPosition },
        },
        include: {
          project: {
            select: {
              id: true,
              userId: true,
              name: true,
              publishedAt: true,
              user: { select: { username: true } },
              engagements: {
                where: { type: ComicEngagementType.Notify },
                select: { userId: true },
              },
            },
          },
        },
      });

      if (!chapter || chapter.project.userId !== ctx.user!.id) {
        throw throwAuthorizationError();
      }

      // Gate early access by the same rules model versions use: score-based
      // max days + concurrent-EA cap. Without this, anyone could lock any
      // chapter behind a paywall regardless of creator standing.
      if (input.earlyAccessConfig) {
        await assertCanGrantEarlyAccess({
          ctx: ctx as any,
          timeframe: input.earlyAccessConfig.timeframe,
          excludeChapterId: chapter.id,
        });
      }

      // Re-trigger ingestion for any panel images still pending scan, and recalculate nsfwLevels
      const panelsWithImages = await dbRead.comicPanel.findMany({
        where: {
          projectId: input.projectId,
          chapterPosition: input.chapterPosition,
          imageId: { not: null },
        },
        select: {
          imageId: true,
          image: { select: { id: true, ingestion: true, nsfwLevel: true } },
        },
      });
      for (const panel of panelsWithImages) {
        if (panel.image && panel.image.ingestion === 'Pending') {
          ingestImageById({ id: panel.image.id }).catch((e) =>
            console.error(`Failed to re-ingest image ${panel.image!.id} during publish:`, e)
          );
        }
      }
      await updateComicNsfwLevels([input.projectId]);

      const isScheduled = input.scheduledAt && input.scheduledAt > new Date();
      const isFirstPublish = chapter.status === ComicChapterStatus.Draft;

      // Compute the EA window. Without an explicit `earlyAccessEndsAt` the
      // purchase mutation short-circuits ("not in early access") even when
      // a config is set, so we have to write both this AND `availability`
      // — otherwise the paywall is invisible from the buyer's side.
      const eaActivatesAt = isScheduled ? input.scheduledAt! : new Date();
      const earlyAccessEndsAt = input.earlyAccessConfig
        ? new Date(
            eaActivatesAt.getTime() + input.earlyAccessConfig.timeframe * 24 * 60 * 60 * 1000
          )
        : null;

      // Compute the next `availability`. When EA is being added we move
      // to `EarlyAccess`. When EA is being removed we revert to `Public`
      // ONLY if the chapter was previously `EarlyAccess` — otherwise
      // (e.g. a chapter that was made `Private` by a moderator) we leave
      // the existing availability alone.
      let nextAvailability: Availability | undefined;
      if (input.earlyAccessConfig !== undefined) {
        if (input.earlyAccessConfig) {
          nextAvailability = Availability.EarlyAccess;
        } else if (chapter.availability === Availability.EarlyAccess) {
          nextAvailability = Availability.Public;
        }
      }

      const updated = await dbWrite.comicChapter.update({
        where: {
          projectId_position: { projectId: input.projectId, position: input.chapterPosition },
        },
        data: {
          status: isScheduled ? ComicChapterStatus.Scheduled : ComicChapterStatus.Published,
          publishedAt: isScheduled ? input.scheduledAt : new Date(),
          ...(input.earlyAccessConfig !== undefined
            ? {
                earlyAccessConfig: input.earlyAccessConfig ?? undefined,
                earlyAccessEndsAt,
                ...(nextAvailability !== undefined ? { availability: nextAvailability } : {}),
              }
            : {}),
        },
      });

      // For scheduled chapters, skip notifications and project publish until the scheduled time
      if (isScheduled) {
        return updated;
      }

      // Re-publishing a live chapter (e.g. to change early access) must not resurface the comic in Newest.
      if (chapter.status !== ComicChapterStatus.Published || !chapter.project.publishedAt) {
        await markComicProjectsChapterPublished([chapter.project.id]);
      }

      // Notify followers on first publish
      if (isFirstPublish) {
        const followerIds = chapter.project.engagements.map((e) => e.userId);
        if (followerIds.length > 0) {
          await createNotification({
            type: 'new-comic-chapter',
            key: `new-comic-chapter:${input.projectId}:${input.chapterPosition}`,
            category: NotificationCategory.Update,
            userIds: followerIds,
            details: {
              comicProjectId: chapter.project.id,
              comicProjectName: chapter.project.name,
              chapterName: chapter.name,
              authorUsername: chapter.project.user.username ?? 'Unknown',
            },
          });
        }
      }

      // Update search index — publishing a chapter may make the project discoverable
      await comicsSearchIndex.queueUpdate(
        [{ id: input.projectId, action: SearchIndexUpdateQueueAction.Update }],
        { reason: 'chapter-publish' }
      );

      return updated;
    }),

  unpublishChapter: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(z.object({ projectId: z.number().int(), chapterPosition: z.number().int().min(0) }))
    .use(isChapterOwner)
    .mutation(async ({ ctx, input }) => {
      const chapter = await dbRead.comicChapter.findUnique({
        where: {
          projectId_position: { projectId: input.projectId, position: input.chapterPosition },
        },
        include: { project: { select: { userId: true } } },
      });
      if (!chapter || chapter.project.userId !== ctx.user!.id) {
        throw throwAuthorizationError();
      }

      // Block unpublish if anyone has purchased early access
      const purchaseCount = await dbRead.entityAccess.count({
        where: {
          accessToId: chapter.id,
          accessToType: 'ComicChapter',
          accessorType: 'User',
        },
      });
      if (purchaseCount > 0) {
        throw throwBadRequestError(
          'This chapter cannot be unpublished because readers have purchased early access to it.'
        );
      }

      const isScheduled = chapter.status === ComicChapterStatus.Scheduled;
      const updated = await dbWrite.comicChapter.update({
        where: {
          projectId_position: { projectId: input.projectId, position: input.chapterPosition },
        },
        data: {
          status: ComicChapterStatus.Draft,
          // Clear publishedAt when canceling a schedule (it was set to the future date)
          ...(isScheduled ? { publishedAt: null } : {}),
          // Reset EA fields so a stale `availability=EarlyAccess` /
          // `earlyAccessEndsAt` from the prior publish doesn't linger and
          // make the chapter look paywalled while it's back in Draft.
          // `purchaseChapterAccess` already blocks an unpublish with
          // outstanding purchases, so we never strand a paid user.
          earlyAccessEndsAt: null,
          availability: Availability.Public,
        },
      });

      // Update search index — unpublishing may affect discoverability
      await comicsSearchIndex.queueUpdate(
        [{ id: input.projectId, action: SearchIndexUpdateQueueAction.Update }],
        { reason: 'comic-edit' }
      );

      return updated;
    }),

  purchaseChapterAccess: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite, blockApiKeys: true })
    .input(
      z.object({
        chapterId: z.number().int(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const chapter = await dbRead.comicChapter.findUnique({
        where: { id: input.chapterId },
        select: {
          id: true,
          name: true,
          availability: true,
          earlyAccessConfig: true,
          earlyAccessEndsAt: true,
          status: true,
          project: { select: { id: true, name: true, userId: true } },
        },
      });

      if (!chapter) throw throwNotFoundError('Chapter not found.');
      if (chapter.project.userId === ctx.user.id) {
        throw throwBadRequestError('You cannot purchase access to your own chapter.');
      }
      if (chapter.status !== ComicChapterStatus.Published) {
        throw throwBadRequestError('Chapter is not published.');
      }

      const eaConfig = chapter.earlyAccessConfig as {
        buzzPrice: number;
        timeframe: number;
      } | null;

      if (
        !eaConfig ||
        chapter.availability !== Availability.EarlyAccess ||
        !chapter.earlyAccessEndsAt ||
        chapter.earlyAccessEndsAt <= new Date()
      ) {
        throw throwBadRequestError('This chapter is not in early access.');
      }

      // Check if user already has access
      const [access] = await hasEntityAccess({
        entityIds: [chapter.id],
        entityType: 'ComicChapter',
        userId: ctx.user.id,
      });

      if (access?.hasAccess) {
        throw throwBadRequestError('You already have access to this chapter.');
      }

      let buzzTransactionId: string | undefined;
      try {
        const externalTransactionIdPrefix = `comic-ea-${chapter.id}-${ctx.user.id}`;
        const spendType = domainSpendType(ctx.features);
        const data = await createMultiAccountBuzzTransaction({
          fromAccountId: ctx.user.id,
          toAccountId: chapter.project.userId,
          amount: eaConfig.buzzPrice,
          type: TransactionType.Purchase,
          description: `Early access: ${chapter.project.name} - ${chapter.name}`,
          details: { comicChapterId: chapter.id, earlyAccessPurchase: true },
          externalTransactionIdPrefix,
          fromAccountTypes: [spendType],
          toAccountType: spendType,
        });

        if (data?.transactionCount === 0) {
          throw throwBadRequestError('Failed to create Buzz transaction.');
        }

        buzzTransactionId = externalTransactionIdPrefix;

        await dbWrite.$transaction(async (tx) => {
          await tx.entityAccess.create({
            data: {
              accessToId: chapter.id,
              accessToType: 'ComicChapter',
              accessorId: ctx.user.id,
              accessorType: 'User',
              permissions:
                EntityAccessPermission.EarlyAccessDownload +
                EntityAccessPermission.EarlyAccessGeneration,
              meta: { buzzTransactionId },
              addedById: ctx.user.id,
            },
          });
        });

        return { success: true };
      } catch (error) {
        if (buzzTransactionId) {
          await refundMultiAccountTransaction({
            externalTransactionIdPrefix: buzzTransactionId,
            description: `Refund early access: ${chapter.project.name} - ${chapter.name}`,
          });
        }
        throw throwDbError(error);
      }
    }),

  updateChapterEarlyAccess: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(
      z.object({
        projectId: z.number().int(),
        chapterPosition: z.number().int().min(0),
        earlyAccessConfig: chapterEarlyAccessConfigSchema,
      })
    )
    .use(isChapterOwner)
    .mutation(async ({ ctx, input }) => {
      const chapter = await dbRead.comicChapter.findUnique({
        where: {
          projectId_position: { projectId: input.projectId, position: input.chapterPosition },
        },
        select: {
          id: true,
          status: true,
          publishedAt: true,
          earlyAccessConfig: true,
          earlyAccessEndsAt: true,
          availability: true,
          project: { select: { userId: true } },
        },
      });

      if (!chapter || chapter.project.userId !== ctx.user!.id) {
        throw throwAuthorizationError();
      }
      if (chapter.status !== ComicChapterStatus.Published) {
        throw throwBadRequestError('Chapter must be published to update early access.');
      }

      const currentConfig = chapter.earlyAccessConfig as {
        buzzPrice: number;
        timeframe: number;
      } | null;

      // If chapter already has EA config, only allow reducing price/timeframe
      if (currentConfig && input.earlyAccessConfig) {
        if (input.earlyAccessConfig.buzzPrice > currentConfig.buzzPrice) {
          throw throwBadRequestError('Cannot increase Buzz price after publishing.');
        }
        if (input.earlyAccessConfig.timeframe > currentConfig.timeframe) {
          throw throwBadRequestError('Cannot increase timeframe after publishing.');
        }
      }

      // Same score-based gating applies when (re-)setting EA. Skip the
      // active-count check when the config is just shrinking (covered by
      // the `excludeChapterId` arg).
      if (input.earlyAccessConfig && !currentConfig) {
        await assertCanGrantEarlyAccess({
          ctx: ctx as any,
          timeframe: input.earlyAccessConfig.timeframe,
          excludeChapterId: chapter.id,
        });
      }

      // Recompute the EA window. The window is anchored at the chapter's
      // publish date, NOT the time of this edit — shrinking the timeframe
      // shrinks the deadline backward, but doesn't restart the clock.
      // For Published chapters `publishedAt` is always set; the fallback
      // is paranoia for direct-DB-edit edge cases.
      const anchor = chapter.publishedAt ?? new Date();
      const earlyAccessEndsAt = input.earlyAccessConfig
        ? new Date(anchor.getTime() + input.earlyAccessConfig.timeframe * 24 * 60 * 60 * 1000)
        : null;

      // Only change `availability` on a real EA transition — don't clobber
      // a Private/etc state that a moderator may have set.
      let nextAvailability: Availability | undefined;
      if (input.earlyAccessConfig) {
        nextAvailability = Availability.EarlyAccess;
      } else if (chapter.availability === Availability.EarlyAccess) {
        nextAvailability = Availability.Public;
      }

      return dbWrite.comicChapter.update({
        where: {
          projectId_position: { projectId: input.projectId, position: input.chapterPosition },
        },
        data: {
          earlyAccessConfig: input.earlyAccessConfig ?? undefined,
          earlyAccessEndsAt,
          ...(nextAvailability !== undefined ? { availability: nextAvailability } : {}),
        },
      });
    }),

  // ──── Moderator Tools ────

  setTosViolation: comicModeratorProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const project = await dbRead.comicProject.findUnique({
        where: { id: input.id },
        select: { id: true, userId: true, name: true, tosViolation: true },
      });

      if (!project) throw throwNotFoundError('Comic not found');

      await dbWrite.comicProject.update({
        where: { id: input.id },
        data: { tosViolation: !project.tosViolation },
      });

      // Notify the creator
      await createNotification({
        userId: project.userId,
        type: 'tos-violation',
        key: `tos-violation:comicProject:${input.id}`,
        category: NotificationCategory.System,
        details: {
          entityType: 'ComicProject',
          entityId: input.id,
          entityName: project.name,
        },
      }).catch((e) => console.error('Failed to send TOS violation notification:', e));

      await trackModActivity(ctx.user.id, {
        entityType: 'comicProject',
        entityId: input.id,
        activity: 'tosViolation',
      });

      // Remove from search index if flagged
      await comicsSearchIndex.queueUpdate(
        [
          {
            id: input.id,
            action: !project.tosViolation
              ? SearchIndexUpdateQueueAction.Delete
              : SearchIndexUpdateQueueAction.Update,
          },
        ],
        { reason: 'comic-edit' }
      );

      return { success: true, tosViolation: !project.tosViolation };
    }),

  setProjectNsfwLevel: comicModeratorProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(
      z.object({
        id: z.number().int(),
        nsfwLevel: z.number().refine((n) => [1, 2, 4, 8, 16, 32].includes(n), 'Invalid NSFW level'),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Stamp every panel image with the moderator's chosen level. The
      // schema accepts only single-bit values (PG / PG-13 / R / X / XXX /
      // Blocked), so this is a "set" — it both lowers content above the
      // chosen level AND raises content below it. The previous cap-only
      // form left a regression where a mod selecting R on a PG-rated
      // project couldn't move the rating up, because the recompute below
      // aggregates from the (unchanged) images.
      await dbWrite.$executeRaw`
        UPDATE "Image" i
        SET "nsfwLevel" = ${input.nsfwLevel}
        FROM "ComicPanel" p
        WHERE p."imageId" = i.id
          AND p."projectId" = ${input.id}
          AND i."nsfwLevel" <> ${input.nsfwLevel}
      `;

      // Recompute chapter levels from the (now-stamped) images, then bubble
      // up to the project level.
      await updateComicNsfwLevels([input.id]);

      await trackModActivity(ctx.user.id, {
        entityType: 'comicProject',
        entityId: input.id,
        activity: 'setNsfwLevel',
      });

      await comicsSearchIndex.queueUpdate(
        [{ id: input.id, action: SearchIndexUpdateQueueAction.Update }],
        { reason: 'nsfw-level' }
      );

      return { success: true };
    }),

  setChapterNsfwLevel: comicModeratorProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(
      z.object({
        projectId: z.number().int(),
        chapterPosition: z.number().int().min(0),
        nsfwLevel: z.number().refine((n) => [1, 2, 4, 8, 16, 32].includes(n), 'Invalid NSFW level'),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Stamp every panel image in this chapter with the moderator's chosen
      // level. Schema accepts single-bit values only, so this works in both
      // directions (lower content above and lift content below). See the
      // matching note on `setProjectNsfwLevel` for why "set" beats "cap".
      await dbWrite.$executeRaw`
        UPDATE "Image" i
        SET "nsfwLevel" = ${input.nsfwLevel}
        FROM "ComicPanel" p
        WHERE p."imageId" = i.id
          AND p."projectId" = ${input.projectId}
          AND p."chapterPosition" = ${input.chapterPosition}
          AND i."nsfwLevel" <> ${input.nsfwLevel}
      `;

      // Recompute the chapter level from its (now-stamped) images, then
      // bubble up to the project level.
      await updateComicNsfwLevels([input.projectId]);

      await trackModActivity(ctx.user.id, {
        entityType: 'comicProject',
        entityId: input.projectId,
        activity: 'setNsfwLevel',
      });

      await comicsSearchIndex.queueUpdate(
        [{ id: input.projectId, action: SearchIndexUpdateQueueAction.Update }],
        { reason: 'nsfw-level' }
      );

      return { success: true };
    }),

  // ──── Moderation tools ────

  moderatorUnpublishChapter: comicModeratorProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(
      z.object({
        projectId: z.number().int(),
        chapterPosition: z.number().int().min(0),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const chapter = await dbRead.comicChapter.findUnique({
        where: {
          projectId_position: { projectId: input.projectId, position: input.chapterPosition },
        },
        include: { project: { select: { userId: true, name: true } } },
      });

      if (!chapter) throw throwNotFoundError('Chapter not found');

      await dbWrite.comicChapter.update({
        where: {
          projectId_position: { projectId: input.projectId, position: input.chapterPosition },
        },
        data: { status: ComicChapterStatus.Draft },
      });

      // Notify the creator
      await createNotification({
        userId: chapter.project.userId,
        type: 'tos-violation',
        key: `mod-unpublish:comicChapter:${input.projectId}:${input.chapterPosition}`,
        category: NotificationCategory.System,
        details: {
          entityType: 'ComicChapter',
          entityId: input.projectId,
          entityName: `${chapter.project.name} - ${chapter.name}`,
        },
      }).catch((e) => console.error('Failed to send mod unpublish notification:', e));

      await trackModActivity(ctx.user.id, {
        entityType: 'comicProject',
        entityId: input.projectId,
        activity: 'unpublishChapter',
      });

      await comicsSearchIndex.queueUpdate(
        [{ id: input.projectId, action: SearchIndexUpdateQueueAction.Update }],
        { reason: 'chapter-edit' }
      );

      return { success: true };
    }),

  // ──── Phase 3: Comic Engagement (Follow/Hide) ────

  toggleComicEngagement: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(
      z.object({
        projectId: z.number().int(),
        type: z.nativeEnum(ComicEngagementType),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // dbWrite, not dbRead: the write below is scoped by the type this read saw, so a
      // replica lagging behind a just-committed change makes the scoped update miss and
      // report not-engaged for a pair that carries exactly what was asked for. Every
      // sibling toggle in this family reads the primary for the same reason.
      const engagement = await dbWrite.comicProjectEngagement.findUnique({
        where: { userId_projectId: { userId: ctx.user.id, projectId: input.projectId } },
      });

      if (engagement) {
        // Toggle off (same type) → set None; switch (different type) → set new type.
        // We never hard-delete: keeping the row (with its `@updatedAt` bumped) is
        // what lets `comicProjectMetrics` detect un-follows incrementally. The row
        // is bounded — one per (userId, projectId) — so it doesn't accumulate.
        const nextType = engagement.type === input.type ? ComicEngagementType.None : input.type;
        // Scoped by the type this call READ, never by the PK alone (868kurkc7). One
        // row per (user, project) carrying one type, so an unqualified update lands
        // on whatever a sibling writer established in between — and the read above is
        // off the REPLICA, so that window is replication lag rather than microseconds.
        const { count } = await dbWrite.comicProjectEngagement.updateMany({
          where: { userId: ctx.user.id, projectId: input.projectId, type: engagement.type },
          data: { type: nextType },
        });
        // Zero rows means the pair is no longer what this call read, so it does not
        // carry `nextType` either, and the client re-reads engagement state anyway.
        return count > 0 && nextType !== ComicEngagementType.None;
      }

      await dbWrite.comicProjectEngagement.create({
        data: {
          userId: ctx.user.id,
          projectId: input.projectId,
          type: input.type,
        },
      });
      return true;
    }),

  getComicEngagement: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(z.object({ projectId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const engagement = await dbRead.comicProjectEngagement.findUnique({
        where: { userId_projectId: { userId: ctx.user.id, projectId: input.projectId } },
      });
      if (!engagement || engagement.type === ComicEngagementType.None) return null;
      return engagement.type;
    }),

  // ──── Phase 3: Chapter Read Tracking (via ComicChapterRead) ────
  // Reads are keyed by the STABLE ComicChapter.id (resolved from the
  // position the client sends), so they survive reorder/republish. `unread`
  // is a soft-delete: an un-read flips the flag and bumps `updatedAt` so the
  // `comicProjectMetrics` cron recomputes readerCount/chapterReadCount
  // incrementally (a hard delete would be invisible to it). The client
  // contract stays position-based; resolution happens server-side.

  markChapterRead: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(z.object({ projectId: z.number().int(), chapterPosition: z.number().int().min(0) }))
    .mutation(async ({ ctx, input }) => {
      const { projectId, chapterPosition } = input;
      const userId = ctx.user.id;
      await dbWrite.$executeRaw`
        INSERT INTO "ComicChapterRead" ("userId", "chapterId", "unread", "createdAt", "updatedAt")
        SELECT ${userId}, cc.id, false, NOW(), NOW()
        FROM "ComicChapter" cc
        WHERE cc."projectId" = ${projectId} AND cc."position" = ${chapterPosition}
        ON CONFLICT ("userId", "chapterId")
        DO UPDATE SET "unread" = false, "updatedAt" = NOW()
      `;
      return { success: true };
    }),

  getChapterReadStatus: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(z.object({ projectId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      // Return the CURRENT positions of the user's read chapters so the reader
      // UI keeps working in positions. Derived from the stable-id read records.
      const rows = await dbRead.$queryRaw<{ position: number }[]>`
        SELECT cc."position"
        FROM "ComicChapterRead" cr
        JOIN "ComicChapter" cc ON cc.id = cr."chapterId"
        WHERE cr."userId" = ${ctx.user.id}
          AND cc."projectId" = ${input.projectId}
          AND cr."unread" = false
      `;
      return rows.map((r) => r.position);
    }),

  markChapterUnread: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(z.object({ projectId: z.number().int(), chapterPosition: z.number().int().min(0) }))
    .mutation(async ({ ctx, input }) => {
      const { projectId, chapterPosition } = input;
      const userId = ctx.user.id;
      await dbWrite.$executeRaw`
        UPDATE "ComicChapterRead" cr
        SET "unread" = true, "updatedAt" = NOW()
        FROM "ComicChapter" cc
        WHERE cc.id = cr."chapterId"
          AND cr."userId" = ${userId}
          AND cc."projectId" = ${projectId}
          AND cc."position" = ${chapterPosition}
      `;
      return { success: true };
    }),

  // ──── Enhance Panel: create from existing image, optionally with img2img ────

  enhancePanel: comicGenerationProcedure
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(enhancePanelSchema)
    .use(isChapterOwner)
    .mutation(async ({ ctx, input }) => {
      const chapter = await dbRead.comicChapter.findUnique({
        where: {
          projectId_position: { projectId: input.projectId, position: input.chapterPosition },
        },
        include: { project: { select: { id: true, userId: true, baseModel: true } } },
      });
      if (!chapter || chapter.project.userId !== ctx.user!.id) {
        throw throwAuthorizationError();
      }
      // Without a prompt the image is saved as the panel, and createImage checks it.
      if (input.prompt?.trim() || input.forceGenerate) {
        await assertGenerationInputUrlsUsable({
          urls: [input.sourceImageUrl],
          userId: ctx.user!.id,
        });
        await assertReferencePanelImageUnblocked(input.referencePanelId, input.projectId);
      }

      // Get next position
      let nextPosition: number;
      if (input.position != null) {
        await dbWrite.comicPanel.updateMany({
          where: {
            projectId: input.projectId,
            chapterPosition: input.chapterPosition,
            position: { gte: input.position },
          },
          data: { position: { increment: 1 } },
        });
        nextPosition = input.position;
      } else {
        const lastPanel = await dbWrite.comicPanel.findFirst({
          where: { projectId: input.projectId, chapterPosition: input.chapterPosition },
          orderBy: { position: 'desc' },
          select: { position: true },
        });
        nextPosition = (lastPanel?.position ?? -1) + 1;
      }

      // No prompt and not forced → create panel directly from image (free)
      if ((!input.prompt || !input.prompt.trim()) && !input.forceGenerate) {
        const image = await createImage({
          url: input.sourceImageUrl,
          type: 'image',
          clientUrl: true,
          userId: ctx.user!.id,
          width: input.sourceImageWidth,
          height: input.sourceImageHeight,
        });

        const panel = await dbWrite.comicPanel.create({
          data: {
            projectId: input.projectId,
            chapterPosition: input.chapterPosition,
            imageId: image.id,
            imageUrl: input.sourceImageUrl,
            prompt: '',
            position: nextPosition,
            status: ComicPanelStatus.Ready,
            metadata: {
              sourceImageUrl: input.sourceImageUrl,
              sourceImageWidth: input.sourceImageWidth,
              sourceImageHeight: input.sourceImageHeight,
            },
          },
        });

        return { ...(await panelForViewer(panel, null, ctx)), referenceImagesSkipped: false };
      }

      // With prompt → img2img generation
      // Fetch previous panel for context if requested
      let contextPanel: {
        id: number;
        prompt: string;
        enhancedPrompt: string | null;
        imageUrl: string | null;
      } | null = null;
      if (input.position != null) {
        contextPanel = await dbRead.comicPanel.findFirst({
          where: {
            projectId: input.projectId,
            chapterPosition: input.chapterPosition,
            position: { lt: input.position },
          },
          orderBy: { position: 'desc' },
          select: { id: true, prompt: true, enhancedPrompt: true, imageUrl: true },
        });
      } else {
        contextPanel = await dbRead.comicPanel.findFirst({
          where: { projectId: input.projectId, chapterPosition: input.chapterPosition },
          orderBy: { position: 'desc' },
          select: { id: true, prompt: true, enhancedPrompt: true, imageUrl: true },
        });
      }
      const effectiveContext = input.useContext ? contextPanel : null;
      const modelConfig = getComicModelConfig(input.baseModel ?? chapter.project.baseModel);
      // For Qwen img2img, use the img2img version if available
      const effectiveVersionId = modelConfig.img2imgVersionId ?? modelConfig.versionId;
      const { width: panelWidth, height: panelHeight } = getAspectRatioDimensions(
        input.aspectRatio,
        modelConfig
      );

      const allUserRefs = await dbRead.comicReference.findMany({
        where: { userId: ctx.user!.id, status: ComicReferenceStatus.Ready },
        select: { id: true, name: true },
      });
      const allReferenceNames = allUserRefs.map((r) => r.name);

      // Resolve @mentions from prompt (for panel association and generation filtering)
      const { mentionedIds } = input.prompt
        ? resolveReferenceMentions({ prompt: input.prompt, references: allUserRefs })
        : { mentionedIds: [] as number[] };
      const mentionedReferenceIds = mentionedIds;

      // Only include references explicitly @mentioned in the prompt or passed via referenceIds
      const allowedRefIds = new Set(allUserRefs.map((r) => r.id));
      let generationReferenceIds: number[];
      if (input.referenceIds && input.referenceIds.length > 0) {
        if (input.referenceIds.some((id) => !allowedRefIds.has(id))) {
          throw throwAuthorizationError();
        }
        generationReferenceIds = input.referenceIds;
      } else {
        generationReferenceIds = mentionedReferenceIds;
      }

      // Gather reference images from selected refs
      let primaryReferenceName = '';
      let referenceImagesSkipped = false;
      const allRefImages: { imageId: number; url: string; width: number; height: number }[] = [];
      for (const refId of generationReferenceIds) {
        const { referenceName, refImages: imgs, skipped } = await getReferenceImages(refId);
        if (!primaryReferenceName && referenceName) primaryReferenceName = referenceName;
        if (skipped) referenceImagesSkipped = true;
        allRefImages.push(...imgs);
      }

      // Filter to user-selected images if specified
      const selectedImageIdSet =
        input.selectedImageIds && input.selectedImageIds.length > 0
          ? new Set(input.selectedImageIds)
          : null;
      const combinedRefImages = (
        selectedImageIdSet
          ? allRefImages.filter((img) => selectedImageIdSet.has(img.imageId))
          : allRefImages
      ).map(({ url, width, height }) => ({ url, width, height }));

      // Build images array: source image first, then reference images, then optional referenced panel image
      const sourceEdgeUrl = getEdgeUrl(input.sourceImageUrl, { original: true });
      const allImages = [
        {
          url: sourceEdgeUrl,
          width: input.sourceImageWidth,
          height: input.sourceImageHeight,
        },
        ...combinedRefImages,
      ];
      let referencePanelImageUrl: string | null = null;
      if (input.referencePanelId) {
        const refPanel = await dbRead.comicPanel.findUnique({
          where: { id: input.referencePanelId },
          include: { chapter: { select: { projectId: true } } },
        });
        if (
          refPanel &&
          refPanel.chapter.projectId === input.projectId &&
          refPanel.status === ComicPanelStatus.Ready &&
          refPanel.imageUrl
        ) {
          referencePanelImageUrl = refPanel.imageUrl;
          const refEdgeUrl = getEdgeUrl(refPanel.imageUrl, { original: true });
          allImages.push({ url: refEdgeUrl, width: panelWidth, height: panelHeight });
        }
      }

      const token = await getOrchestratorToken(ctx.user!.id, ctx);

      // Enforce queue limits before generation
      await assertCanGenerate(token, ctx.user?.tier ?? 'free', 1);

      // Prompt is used as-is — enhancement happens client-side via enhancePromptText
      const userPrompt = input.prompt?.trim() || '';
      const fullPrompt = userPrompt;

      const metadata = {
        sourceImageUrl: input.sourceImageUrl,
        sourceImageWidth: input.sourceImageWidth,
        sourceImageHeight: input.sourceImageHeight,
        referenceImages: combinedRefImages,
        selectedImageIds: input.selectedImageIds ?? null,
        useContext: input.useContext,
        referencePanelId: input.referencePanelId ?? null,
        referencePanelImageUrl,
        enhanceEnabled: false,
        primaryReferenceName,
        allReferenceNames,
        generationParams: {
          engine: modelConfig.engine,
          baseModel: modelConfig.baseModel,
          checkpointVersionId: effectiveVersionId,
          width: panelWidth,
          height: panelHeight,
          prompt: fullPrompt,
          negativePrompt: '',
        },
      };

      const panel = await dbWrite.comicPanel.create({
        data: {
          projectId: input.projectId,
          chapterPosition: input.chapterPosition,
          prompt: userPrompt,
          enhancedPrompt: null,
          position: nextPosition,
          status: ComicPanelStatus.Pending,
          metadata,
        },
      });

      if (mentionedReferenceIds.length > 0) {
        await dbWrite.comicPanelReference.createMany({
          data: mentionedReferenceIds.map((rid) => ({ panelId: panel.id, referenceId: rid })),
          skipDuplicates: true,
        });
      }

      try {
        const result = await submitComicGeneration({
          prompt: fullPrompt || '',
          width: panelWidth,
          height: panelHeight,
          aspectRatio: input.aspectRatio,
          images: allImages,
          modelConfig,
          versionIdOverride: effectiveVersionId,
          user: ctx.user! as SessionUser,
          token,
          features: ctx.features,
          isGreen: ctx.features.isGreen,
          allowMatureContent: ctx.domain === 'green' ? false : undefined,
          track: ctx.track,
        });

        const updated = await dbWrite.comicPanel.update({
          where: { id: panel.id },
          data: { workflowId: result.id, status: ComicPanelStatus.Generating },
        });
        sendComicPanelSignal(ctx.user!.id, {
          panelId: updated.id,
          projectId: input.projectId,
          status: updated.status,
          workflowId: result.id,
        });
        return { ...(await panelForViewer(updated, null, ctx)), referenceImagesSkipped };
      } catch (error: any) {
        console.error('Comics enhancePanel generation failed:', {
          panelId: panel.id,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });

        const userFacingError = getOrchestratorErrorMessage(error);
        const updated = await dbWrite.comicPanel.update({
          where: { id: panel.id },
          data: { status: ComicPanelStatus.Failed, errorMessage: userFacingError },
        });
        sendComicPanelSignal(ctx.user!.id, {
          panelId: updated.id,
          projectId: input.projectId,
          status: updated.status,
        });
        return { ...(await panelForViewer(updated, null, ctx)), referenceImagesSkipped: false };
      }
    }),

  // ──── Bulk Create Panels ────

  bulkCreatePanels: comicGenerationProcedure
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(bulkCreatePanelsSchema)
    .use(isChapterOwner)
    .mutation(async ({ ctx, input }) => {
      // Verify chapter ownership
      const chapter = await dbRead.comicChapter.findUnique({
        where: {
          projectId_position: { projectId: input.projectId, position: input.chapterPosition },
        },
        include: { project: { select: { id: true, userId: true, baseModel: true } } },
      });
      if (!chapter || chapter.project.userId !== ctx.user!.id) {
        throw throwAuthorizationError();
      }
      // A panel without a prompt saves its source image, and createImage checks it.
      await assertGenerationInputUrlsUsable({
        urls: input.panels
          .filter((p) => p.prompt?.trim() && p.sourceImageUrl)
          .map((p) => p.sourceImageUrl),
        userId: ctx.user!.id,
      });

      const bulkModelConfig = getComicModelConfig(input.baseModel ?? chapter.project.baseModel);

      // Get next position after existing panels
      const lastPanel = await dbWrite.comicPanel.findFirst({
        where: { projectId: input.projectId, chapterPosition: input.chapterPosition },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      const nextPosition = (lastPanel?.position ?? -1) + 1;

      // Get all user's ready references (needed for generated panels)
      const allUserRefs = await dbRead.comicReference.findMany({
        where: { userId: ctx.user!.id, status: ComicReferenceStatus.Ready },
        select: { id: true, name: true },
      });
      const allReferenceNames = allUserRefs.map((r) => r.name);

      // Pre-load reference images keyed by refId (only used for panels that @mention them)
      const refImagesByRefId = new Map<
        number,
        {
          referenceName: string;
          images: { url: string; width: number; height: number }[];
          skipped: boolean;
        }
      >();
      let referenceImagesSkipped = false;
      for (const ref of allUserRefs) {
        const { referenceName, refImages: imgs, skipped } = await getReferenceImages(ref.id);
        refImagesByRefId.set(ref.id, {
          referenceName: referenceName ?? ref.name,
          images: imgs.map(({ url, width, height }) => ({ url, width, height })),
          skipped,
        });
      }

      const batchToken = await getOrchestratorToken(ctx.user!.id, ctx);

      // Count panels that need generation (Mode 3 and Mode 4)
      // Mode 1 (existing imageId) and Mode 2 (source only, no prompt) don't use generation
      // Mode 3 (source + prompt) and Mode 4 (prompt only) need generation
      const panelsNeedingGeneration = input.panels.filter((p) => {
        const hasPrompt = !!p.prompt?.trim();
        const hasExistingImage = p.imageId != null;
        return !hasExistingImage && hasPrompt;
      }).length;

      // Check queue limits before creating any panels
      if (panelsNeedingGeneration > 0) {
        await assertCanGenerate(batchToken, ctx.user?.tier ?? 'free', panelsNeedingGeneration);
      }

      const createdPanels: any[] = [];
      let contextPanel: {
        id: number;
        prompt: string;
        enhancedPrompt: string | null;
        imageUrl: string | null;
      } | null = null;

      // Get the last panel for initial context
      if (nextPosition > 0) {
        contextPanel = await dbRead.comicPanel.findFirst({
          where: { projectId: input.projectId, chapterPosition: input.chapterPosition },
          orderBy: { position: 'desc' },
          select: { id: true, prompt: true, enhancedPrompt: true, imageUrl: true },
        });
      }

      for (let i = 0; i < input.panels.length; i++) {
        const panelDef = input.panels[i];
        const position = nextPosition + i;

        // Mode 1: Import from existing image ID
        if (panelDef.imageId != null) {
          const image = await getOwnedImageOrThrow(panelDef.imageId, ctx.user!.id);

          const panel = await dbWrite.comicPanel.create({
            data: {
              projectId: input.projectId,
              chapterPosition: input.chapterPosition,
              imageId: image.id,
              imageUrl: image.url,
              prompt: panelDef.prompt ?? '',
              position,
              status: ComicPanelStatus.Ready,
            },
          });

          await updateComicNsfwLevels([input.projectId]).catch((e) =>
            console.error(`Failed to update NSFW levels for project ${input.projectId}:`, e)
          );

          createdPanels.push(panel);
          contextPanel = {
            id: panel.id,
            prompt: panel.prompt,
            enhancedPrompt: null,
            imageUrl: panel.imageUrl,
          };
          continue;
        }

        // Mode 2: Source image without prompt — create directly (free)
        if (panelDef.sourceImageUrl && (!panelDef.prompt || !panelDef.prompt.trim())) {
          // Forward whatever generation metadata the client extracted (PNG
          // tags for file uploads, workflow step meta for generator picks).
          // `createImageResources` reads the meta + hashes via the
          // `get_image_resources(imageId)` DB function and materializes the
          // matching `ImageResourceNew` rows — so resource attribution
          // survives the import without us re-implementing the matching.
          const image = await createImage({
            url: panelDef.sourceImageUrl,
            type: 'image',
            clientUrl: true,
            userId: ctx.user!.id,
            width: panelDef.sourceImageWidth ?? 512,
            height: panelDef.sourceImageHeight ?? 512,
            meta: panelDef.meta,
          });
          await createImageResources({ imageId: image.id }).catch((e) =>
            console.error(
              `Failed to materialize resources for bulk-created panel image ${image.id}:`,
              e
            )
          );

          const panel = await dbWrite.comicPanel.create({
            data: {
              projectId: input.projectId,
              chapterPosition: input.chapterPosition,
              imageId: image.id,
              imageUrl: panelDef.sourceImageUrl,
              prompt: '',
              position,
              status: ComicPanelStatus.Ready,
              metadata: {
                sourceImageUrl: panelDef.sourceImageUrl,
                sourceImageWidth: panelDef.sourceImageWidth,
                sourceImageHeight: panelDef.sourceImageHeight,
              },
            },
          });

          createdPanels.push(panel);
          contextPanel = {
            id: panel.id,
            prompt: '',
            enhancedPrompt: null,
            imageUrl: panel.imageUrl,
          };
          continue;
        }

        // Mode 3: Source image + prompt — img2img enhancement (costs buzz)
        if (panelDef.sourceImageUrl && panelDef.prompt?.trim()) {
          // Resolve @mentions from prompt — only mentioned refs get their images included
          const { mentionedIds } = resolveReferenceMentions({
            prompt: panelDef.prompt,
            references: allUserRefs,
          });
          const mentionedRefImages = mentionedIds.flatMap(
            (id) => refImagesByRefId.get(id)?.images ?? []
          );
          if (mentionedIds.some((id) => refImagesByRefId.get(id)?.skipped)) {
            referenceImagesSkipped = true;
          }
          const panelPrimaryRefName =
            mentionedIds.length > 0
              ? refImagesByRefId.get(mentionedIds[0])?.referenceName ?? ''
              : '';
          const mentionedRefNames = mentionedIds
            .map((id) => refImagesByRefId.get(id)?.referenceName ?? '')
            .filter(Boolean);

          // Prompt is used as-is — enhancement happens client-side
          const fullPrompt = panelDef.prompt;

          const sourceEdgeUrl = getEdgeUrl(panelDef.sourceImageUrl, { original: true });
          const allImages = [
            {
              url: sourceEdgeUrl,
              width: panelDef.sourceImageWidth ?? 512,
              height: panelDef.sourceImageHeight ?? 512,
            },
            ...mentionedRefImages,
          ];

          // For Qwen img2img, use the img2img version if available
          const bulkVersionId = panelDef.sourceImageUrl
            ? bulkModelConfig.img2imgVersionId ?? bulkModelConfig.versionId
            : bulkModelConfig.versionId;
          const { width: bulkPanelW, height: bulkPanelH } = getAspectRatioDimensions(
            panelDef.aspectRatio,
            bulkModelConfig
          );

          const metadata = {
            sourceImageUrl: panelDef.sourceImageUrl,
            sourceImageWidth: panelDef.sourceImageWidth,
            sourceImageHeight: panelDef.sourceImageHeight,
            referenceImages: mentionedRefImages,
            enhanceEnabled: false,
            primaryReferenceName: panelPrimaryRefName,
            allReferenceNames: mentionedRefNames,
            generationParams: {
              engine: bulkModelConfig.engine,
              baseModel: bulkModelConfig.baseModel,
              checkpointVersionId: bulkVersionId,
              width: bulkPanelW,
              height: bulkPanelH,
              prompt: fullPrompt,
              negativePrompt: '',
            },
          };

          const panel = await dbWrite.comicPanel.create({
            data: {
              projectId: input.projectId,
              chapterPosition: input.chapterPosition,
              prompt: panelDef.prompt,
              enhancedPrompt: null,
              position,
              status: ComicPanelStatus.Pending,
              metadata,
            },
          });

          if (mentionedIds.length > 0) {
            await dbWrite.comicPanelReference.createMany({
              data: mentionedIds.map((rid) => ({ panelId: panel.id, referenceId: rid })),
              skipDuplicates: true,
            });
          }

          try {
            const result = await submitComicGeneration({
              prompt: fullPrompt,
              width: bulkPanelW,
              height: bulkPanelH,
              aspectRatio: panelDef.aspectRatio,
              images: allImages,
              modelConfig: bulkModelConfig,
              versionIdOverride: bulkVersionId,
              user: ctx.user! as SessionUser,
              token: batchToken,
              features: ctx.features,
              isGreen: ctx.features.isGreen,
              allowMatureContent: ctx.domain === 'green' ? false : undefined,
              track: ctx.track,
            });

            const updated = await dbWrite.comicPanel.update({
              where: { id: panel.id },
              data: { workflowId: result.id, status: ComicPanelStatus.Generating },
            });
            sendComicPanelSignal(ctx.user!.id, {
              panelId: updated.id,
              projectId: input.projectId,
              status: updated.status,
              workflowId: result.id,
            });
            createdPanels.push(updated);
            contextPanel = {
              id: updated.id,
              prompt: panelDef.prompt,
              enhancedPrompt: updated.enhancedPrompt,
              imageUrl: updated.imageUrl,
            };
          } catch (error: any) {
            console.error('Comics bulkCreatePanels generation failed:', {
              panelId: panel.id,
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            });

            const userFacingError = getOrchestratorErrorMessage(error);
            const updated = await dbWrite.comicPanel.update({
              where: { id: panel.id },
              data: { status: ComicPanelStatus.Failed, errorMessage: userFacingError },
            });
            sendComicPanelSignal(ctx.user!.id, {
              panelId: updated.id,
              projectId: input.projectId,
              status: updated.status,
            });
            createdPanels.push(updated);
            contextPanel = {
              id: updated.id,
              prompt: panelDef.prompt,
              enhancedPrompt: updated.enhancedPrompt,
              imageUrl: null,
            };
          }
          continue;
        }

        // Mode 4: Only prompt — text2img generation (costs buzz)
        if (panelDef.prompt?.trim()) {
          const { mentionedIds } = resolveReferenceMentions({
            prompt: panelDef.prompt,
            references: allUserRefs,
          });
          const mentionedRefImages = mentionedIds.flatMap(
            (id) => refImagesByRefId.get(id)?.images ?? []
          );
          if (mentionedIds.some((id) => refImagesByRefId.get(id)?.skipped)) {
            referenceImagesSkipped = true;
          }
          const panelPrimaryRefName =
            mentionedIds.length > 0
              ? refImagesByRefId.get(mentionedIds[0])?.referenceName ?? ''
              : '';
          const mentionedRefNames = mentionedIds
            .map((id) => refImagesByRefId.get(id)?.referenceName ?? '')
            .filter(Boolean);

          const { width: txtPanelW, height: txtPanelH } = getAspectRatioDimensions(
            panelDef.aspectRatio,
            bulkModelConfig
          );
          const panel = await createSinglePanel({
            projectId: input.projectId,
            chapterPosition: input.chapterPosition,
            referenceIds: mentionedIds,
            prompt: panelDef.prompt,
            position,
            contextPanel,
            allReferenceNames: mentionedRefNames,
            primaryReferenceName: panelPrimaryRefName,
            refImages: mentionedRefImages,
            userId: ctx.user!.id,
            ctx,
            width: txtPanelW,
            height: txtPanelH,
            aspectRatio: panelDef.aspectRatio,
            modelConfig: bulkModelConfig,
          });

          createdPanels.push(panel);
          contextPanel = {
            id: panel.id,
            prompt: panelDef.prompt,
            enhancedPrompt: panel.enhancedPrompt,
            imageUrl: panel.imageUrl,
          };
          continue;
        }

        // No valid configuration — skip this panel
        throw throwBadRequestError(`Panel ${i + 1} has no prompt, source image, or image ID`);
      }

      return { panels: await panelsForViewer(createdPanels, ctx), referenceImagesSkipped };
    }),

  // ──── Phase 2: Create panel from existing Image (manual mode) ────

  createPanelFromImage: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(
      z.object({
        projectId: z.number().int(),
        chapterPosition: z.number().int().min(0),
        imageId: z.number().int().positive(),
        prompt: z.string().min(1).max(2000).default(''),
        position: z.number().int().min(0).optional(),
      })
    )
    .use(isChapterOwner)
    .mutation(async ({ ctx, input }) => {
      // Verify the image belongs to the user
      const image = await getOwnedImageOrThrow(input.imageId, ctx.user!.id);

      // Get next position
      let nextPosition: number;
      if (input.position != null) {
        await dbWrite.comicPanel.updateMany({
          where: {
            projectId: input.projectId,
            chapterPosition: input.chapterPosition,
            position: { gte: input.position },
          },
          data: { position: { increment: 1 } },
        });
        nextPosition = input.position;
      } else {
        const lastPanel = await dbWrite.comicPanel.findFirst({
          where: { projectId: input.projectId, chapterPosition: input.chapterPosition },
          orderBy: { position: 'desc' },
          select: { position: true },
        });
        nextPosition = (lastPanel?.position ?? -1) + 1;
      }

      const panel = await dbWrite.comicPanel.create({
        data: {
          projectId: input.projectId,
          chapterPosition: input.chapterPosition,
          imageId: input.imageId,
          imageUrl: image.url,
          prompt: input.prompt,
          position: nextPosition,
          status: ComicPanelStatus.Ready,
        },
      });

      // Update NSFW levels — image is already scanned so update directly
      await updateComicNsfwLevels([input.projectId]).catch((e) =>
        console.error(`Failed to update NSFW levels for project ${input.projectId}:`, e)
      );

      return panelForViewer(panel, null, ctx);
    }),

  // ──── Phase 4: Reference aliases ────

  getReference: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(z.object({ referenceId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const reference = await dbRead.comicReference.findUnique({
        where: { id: input.referenceId },
        include: {
          images: {
            orderBy: { position: 'asc' },
            include: { image: { select: referenceImageSelect } },
          },
        },
      });
      if (!reference || reference.userId !== ctx.user.id) {
        throw throwAuthorizationError();
      }
      return referenceForViewer(reference, ctx);
    }),

  deleteReference: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaDelete })
    .input(deleteReferenceSchema)
    .mutation(async ({ ctx, input }) => {
      const reference = await dbRead.comicReference.findUnique({
        where: { id: input.referenceId },
        select: { userId: true },
      });
      if (!reference || reference.userId !== ctx.user.id) {
        throw throwAuthorizationError();
      }
      await dbWrite.comicReference.delete({
        where: { id: input.referenceId },
      });
      return { success: true };
    }),

  updateReference: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(updateReferenceSchema)
    .mutation(async ({ ctx, input }) => {
      const reference = await dbRead.comicReference.findUnique({
        where: { id: input.referenceId },
        select: { userId: true },
      });
      if (!reference || reference.userId !== ctx.user.id) {
        throw throwAuthorizationError();
      }
      await throwOnBlockedUserContent(input.name, {
        isModerator: ctx.user.isModerator,
        surface: 'comic',
      });
      const updated = await dbWrite.comicReference.update({
        where: { id: input.referenceId },
        data: { name: input.name },
      });
      return updated;
    }),

  deleteReferenceImage: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaDelete })
    .input(z.object({ referenceId: z.number().int(), imageId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const reference = await dbRead.comicReference.findUnique({
        where: { id: input.referenceId },
        select: { userId: true },
      });
      if (!reference || reference.userId !== ctx.user.id) {
        throw throwAuthorizationError();
      }

      await dbWrite.$transaction(async (tx) => {
        await tx.comicReferenceImage.delete({
          where: {
            referenceId_imageId: { referenceId: input.referenceId, imageId: input.imageId },
          },
        });

        // Re-compact positions
        const remaining = await tx.comicReferenceImage.findMany({
          where: { referenceId: input.referenceId },
          orderBy: { position: 'asc' },
          select: { imageId: true },
        });
        for (let i = 0; i < remaining.length; i++) {
          await tx.comicReferenceImage.update({
            where: {
              referenceId_imageId: {
                referenceId: input.referenceId,
                imageId: remaining[i].imageId,
              },
            },
            data: { position: i },
          });
        }
      });

      return { success: true };
    }),

  reorderReferenceImages: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(
      z.object({
        referenceId: z.number().int(),
        imageIds: z.array(z.number().int()),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const reference = await dbRead.comicReference.findUnique({
        where: { id: input.referenceId },
        select: { userId: true },
      });
      if (!reference || reference.userId !== ctx.user.id) {
        throw throwAuthorizationError();
      }

      // Verify all imageIds belong to this reference
      const existingImages = await dbRead.comicReferenceImage.findMany({
        where: { referenceId: input.referenceId },
        select: { imageId: true },
      });
      const existingIds = new Set(existingImages.map((img) => img.imageId));
      for (const imageId of input.imageIds) {
        if (!existingIds.has(imageId)) {
          throw throwBadRequestError(`Image ${imageId} does not belong to this reference`);
        }
      }

      await dbWrite.$transaction(
        input.imageIds.map((imageId, i) =>
          dbWrite.comicReferenceImage.update({
            where: {
              referenceId_imageId: { referenceId: input.referenceId, imageId },
            },
            data: { position: i },
          })
        )
      );

      return { success: true };
    }),

  getUserReferences: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(
      z
        .object({
          type: z.nativeEnum(ComicReferenceType).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const where: any = { userId: ctx.user.id };
      if (input?.type) where.type = input.type;
      const references = await dbRead.comicReference.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          images: {
            orderBy: { position: 'asc' },
            include: { image: { select: referenceImageSelect } },
          },
        },
      });
      return references.map((reference) => referenceForViewer(reference, ctx));
    }),

  // ──── Project-scoped references ────

  addReferenceToProject: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(z.object({ projectId: z.number().int(), referenceId: z.number().int() }))
    .use(isProjectOwner)
    .mutation(async ({ ctx, input }) => {
      // Verify the reference belongs to the user
      const reference = await dbRead.comicReference.findUnique({
        where: { id: input.referenceId },
        select: { userId: true },
      });
      if (!reference || reference.userId !== ctx.user!.id) {
        throw throwAuthorizationError();
      }

      await dbWrite.comicProjectReference.upsert({
        where: {
          projectId_referenceId: {
            projectId: input.projectId,
            referenceId: input.referenceId,
          },
        },
        create: {
          projectId: input.projectId,
          referenceId: input.referenceId,
        },
        update: {},
      });

      return { success: true };
    }),

  removeReferenceFromProject: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(z.object({ projectId: z.number().int(), referenceId: z.number().int() }))
    .use(isProjectOwner)
    .mutation(async ({ ctx, input }) => {
      await dbWrite.comicProjectReference.deleteMany({
        where: {
          projectId: input.projectId,
          referenceId: input.referenceId,
        },
      });

      return { success: true };
    }),

  getImportableReferences: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(z.object({ projectId: z.number().int() }))
    .use(isProjectOwner)
    .query(async ({ ctx, input }) => {
      // Get reference IDs already associated with this project
      const existing = await dbRead.comicProjectReference.findMany({
        where: { projectId: input.projectId },
        select: { referenceId: true },
      });
      const existingIds = existing.map((e) => e.referenceId);

      // Fetch user's references NOT in this project
      const references = await dbRead.comicReference.findMany({
        where: {
          userId: ctx.user!.id,
          ...(existingIds.length > 0 ? { id: { notIn: existingIds } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        include: {
          images: {
            orderBy: { position: 'asc' },
            take: 1,
            include: { image: { select: referenceImageSelect } },
          },
          _count: { select: { images: true } },
        },
      });

      return references.map((reference) => referenceForViewer(reference, ctx));
    }),

  // ──── Queue Status ────

  /**
   * Get the current queue status for the user.
   * Returns used slots, limit, available slots, and whether the user can generate.
   */
  getQueueStatus: comicProtectedProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .query(async ({ ctx }) => {
      const token = await getOrchestratorToken(ctx.user!.id, ctx);
      const userTier = ctx.user?.tier ?? 'free';
      return getUserQueueStatus(token, userTier);
    }),
});
