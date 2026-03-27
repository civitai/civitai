import { z } from 'zod';
import type { SessionUser } from 'next-auth';
import { comicProjectMetaSchema, parseComicProjectMeta } from '~/server/schema/comics.schema';
import {
  router,
  protectedProcedure,
  publicProcedure,
  moderatorProcedure,
  middleware,
  isFlagProtected,
} from '~/server/trpc';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import {
  Availability,
  ComicReferenceStatus,
  ComicChapterStatus,
  ComicEngagementType,
  ComicGenre,
  ComicPanelStatus,
  ComicProjectStatus,
  ComicReferenceType,
} from '~/shared/utils/prisma/enums';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { pollIterationWorkflow } from '~/server/services/orchestrator/poll-iteration';
import { createImageGen } from '~/server/services/orchestrator/imageGen/imageGen';
import { assertCanGenerate, getUserQueueStatus } from '~/server/services/orchestrator/queue-limits';
import { getWorkflow, submitWorkflow } from '~/server/services/orchestrator/workflows';
import { createImageGenStep } from '~/server/services/orchestrator/imageGen/imageGen';
import { enhanceComicPrompt } from '~/server/services/comics/prompt-enhance';
import { orchestratorChatCompletionCost } from '~/server/services/comics/orchestrator-chat';
import { resolveReferenceMentions } from '~/server/services/comics/mention-resolver';
import {
  updateComicChapterNsfwLevels,
  updateComicProjectNsfwLevels,
} from '~/server/services/nsfwLevels.service';
import { createImage, ingestImageById } from '~/server/services/image.service';
import { createNotification } from '~/server/services/notification.service';
import { planChapterPanels } from '~/server/services/comics/story-plan';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { commentV2Select } from '~/server/selectors/commentv2.selector';
import {
  EntityAccessPermission,
  NotificationCategory,
  SearchIndexUpdateQueueAction,
  SignalMessages,
} from '~/server/common/enums';
import { signalClient } from '~/utils/signal-client';
import { comicsSearchIndex } from '~/server/search-index';
import {
  commonAspectRatios,
  nanoBananaProSizes,
  seedreamSizes,
  qwenSizes,
  grokSizes,
} from '~/server/common/constants';
import { hasEntityAccess } from '~/server/services/common.service';
import {
  createMultiAccountBuzzTransaction,
  refundMultiAccountTransaction,
} from '~/server/services/buzz.service';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { trackModActivity } from '~/server/services/moderator.service';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getS3Client } from '~/utils/s3-utils';
import { env } from '~/env/server';
import { randomUUID } from 'crypto';

// Feature flag gate — all procedures require the comicCreator flag
const comicFlag = isFlagProtected('comicCreator');
const comicProtectedProcedure = protectedProcedure.use(comicFlag);
const comicPublicProcedure = publicProcedure.use(comicFlag);
const comicModeratorProcedure = moderatorProcedure.use(comicFlag);

// Multi-model configuration for comic panel generation
const COMIC_MODEL_CONFIG: Record<
  string,
  {
    engine: string;
    baseModel: string;
    versionId: number;
    img2imgVersionId?: number;
    maxReferenceImages: number;
    sizes: { label: string; width: number; height: number }[];
  }
> = {
  NanoBanana: {
    engine: 'gemini',
    baseModel: 'NanoBanana',
    versionId: 2436219,
    maxReferenceImages: 7,
    sizes: nanoBananaProSizes,
  },
  Flux2: {
    engine: 'flux2',
    baseModel: 'Flux.2 D',
    versionId: 2439067,
    maxReferenceImages: 7,
    sizes: commonAspectRatios,
  },
  Seedream: {
    engine: 'seedream',
    baseModel: 'Seedream',
    versionId: 2470991,
    maxReferenceImages: 7,
    sizes: seedreamSizes,
  },
  OpenAI: {
    engine: 'openai',
    baseModel: 'OpenAI',
    versionId: 2512167,
    maxReferenceImages: 7,
    sizes: [
      { label: '1:1', width: 1024, height: 1024 },
      { label: '3:2', width: 1536, height: 1024 },
      { label: '2:3', width: 1024, height: 1536 },
    ],
  },
  Qwen: {
    engine: 'qwen',
    baseModel: 'Qwen',
    versionId: 2552908,
    img2imgVersionId: 2558804,
    maxReferenceImages: 3,
    sizes: qwenSizes,
  },
  SeedreamLite: {
    engine: 'seedream',
    baseModel: 'Seedream',
    versionId: 2720141,
    maxReferenceImages: 7,
    sizes: seedreamSizes,
  },
  Grok: {
    engine: 'grok',
    baseModel: 'Grok',
    versionId: 2738377,
    maxReferenceImages: 7,
    sizes: grokSizes,
  },
};

const DEFAULT_COMIC_MODEL = 'NanoBanana';
const DEFAULT_ASPECT_RATIO = '3:4';

function getComicModelConfig(baseModel?: string | null) {
  return COMIC_MODEL_CONFIG[baseModel ?? DEFAULT_COMIC_MODEL] ?? COMIC_MODEL_CONFIG[DEFAULT_COMIC_MODEL];
}

function getAspectRatioDimensions(
  aspectRatio: string,
  modelConfig?: (typeof COMIC_MODEL_CONFIG)[string]
) {
  const sizes = modelConfig?.sizes ?? COMIC_MODEL_CONFIG[DEFAULT_COMIC_MODEL].sizes;
  const match = sizes.find((s) => s.label === aspectRatio);
  return match ?? sizes.find((s) => s.label === '3:4' || s.label === 'Portrait') ?? sizes[0];
}

// Cap reference images to prevent API rejection (too many images)
function capReferenceImages(
  images: { url: string; width: number; height: number }[],
  max: number
): { url: string; width: number; height: number }[] {
  if (images.length <= max) return images;
  return images.slice(0, max);
}

/** Detect orchestrator/generator offline errors and return a user-friendly message. */
function getOrchestratorErrorMessage(error: unknown): string {
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
  signalClient
    .send({ userId, target: SignalMessages.ComicPanelUpdate, data })
    .catch(() => {}); // Fire-and-forget
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
const createProjectSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(5000).optional(),
  genre: z.nativeEnum(ComicGenre).optional(),
  coverUrl: z.string().optional(),
  heroUrl: z.string().optional(),
  heroImagePosition: z.number().int().min(0).max(100).optional(),
});

const getProjectSchema = z.object({
  id: z.number().int(),
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
        url: z.string().min(1),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
    )
    .min(1)
    .max(10),
});

const comicModelEnum = z.enum(['NanoBanana', 'Flux2', 'Seedream', 'SeedreamLite', 'OpenAI', 'Qwen', 'Grok']);

const createPanelSchema = z.object({
  projectId: z.number().int(),
  chapterPosition: z.number().int().min(0),
  referenceIds: z.array(z.number().int()).optional(),
  selectedImageIds: z.array(z.number().int()).optional(),
  prompt: z.string().min(1).max(2000),
  useContext: z.boolean().default(true),
  referencePanelId: z.number().int().optional(),
  layoutImagePath: z.string().optional(),
  position: z.number().int().min(0).optional(),
  aspectRatio: z.string().default('3:4'),
  baseModel: comicModelEnum.nullish(),
  quantity: z.number().int().min(1).max(4).default(1),
});

const updatePanelSchema = z.object({
  panelId: z.number().int(),
  status: z.nativeEnum(ComicPanelStatus).optional(),
  imageUrl: z.string().nullish(),
  civitaiJobId: z.string().optional(),
  errorMessage: z.string().nullish(),
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
  sourceImageUrl: z.string().min(1),
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
        sourceImageUrl: z.string().optional(),
        sourceImageWidth: z.number().int().positive().optional(),
        sourceImageHeight: z.number().int().positive().optional(),
        // For import mode (existing image ID)
        imageId: z.number().int().optional(),
        aspectRatio: z.string().default('3:4'),
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

const chapterEarlyAccessConfigSchema = z
  .object({
    buzzPrice: z.number().int().min(1).max(10000),
    timeframe: z.number().int().min(1).max(30),
  })
  .nullable();

// Shared helper: resolve a reference's images for generation
async function getReferenceImages(referenceId: number) {
  const reference = await dbRead.comicReference.findUnique({
    where: { id: referenceId },
    select: {
      name: true,
      images: {
        orderBy: { position: 'asc' },
        include: { image: { select: { id: true, url: true, width: true, height: true } } },
      },
    },
  });

  if (!reference) return { referenceName: '', refImages: [] };

  return {
    referenceName: reference.name,
    refImages: reference.images.map((ri) => ({
      imageId: ri.image.id,
      url: getEdgeUrl(ri.image.url, { original: true }),
      width: ri.image.width ?? 512,
      height: ri.image.height ?? 512,
    })),
  };
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
    const result = await createImageGen({
      params: {
        prompt: fullPrompt,
        negativePrompt: '',
        engine: modelConfig.engine,
        baseModel: modelConfig.baseModel as any,
        width,
        height,
        aspectRatio,
        workflow: 'txt2img',
        sampler: 'Euler',
        steps: 25,
        quantity: 1,
        draft: false,
        disablePoi: false,
        priority: 'low',
        sourceImage: null,
        images: capReferenceImages(refImages, modelConfig.maxReferenceImages),
      },
      resources: [{ id: modelConfig.versionId, strength: 1 }],
      tags: ['comics'],
      tips: { creators: 0, civitai: 0 },
      user: ctx.user! as SessionUser,
      token,
      currencies: ['yellow'],
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
  getMyProjects: comicProtectedProcedure.query(async ({ ctx }) => {
    const projects = await dbRead.comicProject.findMany({
      where: {
        userId: ctx.user.id,
        status: ComicProjectStatus.Active,
      },
      include: {
        coverImage: { select: { id: true, url: true, nsfwLevel: true } },
        heroImage: { select: { id: true, url: true, nsfwLevel: true } },
        chapters: {
          include: {
            _count: { select: { panels: true } },
            panels: {
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
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        coverImage: p.coverImage,
        heroImage: p.heroImage,
        panelCount,
        thumbnailUrl,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      };
    });
  }),

  getProject: comicProtectedProcedure.input(getProjectSchema).query(async ({ ctx, input }) => {
    // Use dbWrite for read-after-write consistency — this is a single-user workspace
    // query that is frequently refetched immediately after mutations.
    const project = await dbWrite.comicProject.findUnique({
      where: { id: input.id },
      include: {
        coverImage: { select: { id: true, url: true, nsfwLevel: true } },
        heroImage: { select: { id: true, url: true, nsfwLevel: true } },
        chapters: {
          orderBy: { position: 'asc' },
          include: {
            panels: {
              orderBy: { position: 'asc' },
              include: {
                references: {
                  select: { referenceId: true },
                },
                image: {
                  select: { nsfwLevel: true, width: true, height: true },
                },
              },
            },
          },
        },
      },
    });

    if (!project) {
      throw throwNotFoundError();
    }

    if (project.userId !== ctx.user.id) {
      throw throwAuthorizationError();
    }

    // Fetch project-scoped references via junction table
    // Use dbWrite for read-after-write consistency (same as project query above)
    const projectRefs = await dbWrite.comicProjectReference.findMany({
      where: { projectId: project.id },
      select: { referenceId: true },
    });

    let references;
    if (projectRefs.length > 0) {
      // Project has scoped references — fetch only those
      const refIds = projectRefs.map((pr) => pr.referenceId);
      references = await dbWrite.comicReference.findMany({
        where: { id: { in: refIds }, userId: ctx.user.id },
        orderBy: { createdAt: 'asc' },
        include: {
          images: {
            orderBy: { position: 'asc' },
            include: { image: { select: { id: true, url: true, width: true, height: true } } },
          },
        },
      });
    } else {
      // Backward compat: no junction rows yet — show all user references
      references = await dbWrite.comicReference.findMany({
        where: { userId: ctx.user.id },
        orderBy: { createdAt: 'asc' },
        include: {
          images: {
            orderBy: { position: 'asc' },
            include: { image: { select: { id: true, url: true, width: true, height: true } } },
          },
        },
      });
    }

    return {
      ...project,
      references,
    };
  }),

  getProjectForReader: comicProtectedProcedure
    .input(getProjectSchema)
    .query(async ({ ctx, input }) => {
      const project = await dbRead.comicProject.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          name: true,
          userId: true,
          meta: true,
          chapters: {
            orderBy: { position: 'asc' },
            select: {
              projectId: true,
              name: true,
              position: true,
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
                },
              },
            },
          },
        },
      });

      if (!project || (project.userId !== ctx.user.id && !ctx.user.isModerator)) {
        throw throwAuthorizationError();
      }

      return {
        id: project.id,
        name: project.name,
        meta: parseComicProjectMeta(project.meta),
        chapters: project.chapters,
      };
    }),

  // Public queries — no auth required
  getPublicProjects: comicPublicProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(50).default(20),
        cursor: z.number().int().optional(),
        genre: z.nativeEnum(ComicGenre).optional(),
        period: z.enum(['Day', 'Week', 'Month', 'Year', 'AllTime']).optional(),
        sort: z.enum(['Newest', 'MostFollowed', 'MostChapters']).default('Newest'),
        followed: z.boolean().optional(),
        userId: z.number().optional(),
        browsingLevel: z.number().int().min(0).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const { limit, cursor, genre, period, sort, followed, userId, browsingLevel } = input;

      // Build where clause
      const where: any = {
        status: ComicProjectStatus.Active,
        tosViolation: false,
        chapters: {
          some: {
            status: ComicChapterStatus.Published,
            panels: {
              some: {
                status: ComicPanelStatus.Ready,
                imageUrl: { not: null },
              },
            },
          },
        },
      };

      if (genre) where.genre = genre;
      if (userId) where.userId = userId;

      // NSFW browsing level filter — compute allowed nsfwLevel values using bitwise match
      if (browsingLevel != null && browsingLevel > 0) {
        const allowedNsfwLevels = [0]; // Always include unclassified (nsfwLevel=0)
        for (let i = 1; i <= 63; i++) {
          if ((i & browsingLevel) !== 0) allowedNsfwLevels.push(i);
        }
        where.nsfwLevel = { in: allowedNsfwLevels };
      }

      if (period && period !== 'AllTime') {
        const periodMap: Record<string, number> = {
          Day: 1,
          Week: 7,
          Month: 30,
          Year: 365,
        };
        const days = periodMap[period];
        if (days) {
          const since = new Date();
          since.setDate(since.getDate() - days);
          where.updatedAt = { gte: since };
        }
      }

      if (followed && ctx.user) {
        where.engagements = {
          some: { userId: ctx.user.id, type: ComicEngagementType.Notify },
        };
      }

      // Build orderBy – always include id tie-breaker for stable cursor pagination
      let orderBy: any[] = [{ updatedAt: 'desc' }, { id: 'desc' }];
      if (sort === 'MostFollowed') {
        orderBy = [{ engagements: { _count: 'desc' } }, { id: 'desc' }];
      } else if (sort === 'MostChapters') {
        orderBy = [{ chapters: { _count: 'desc' } }, { id: 'desc' }];
      }

      const projects = await dbRead.comicProject.findMany({
        where,
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        orderBy,
        select: {
          id: true,
          name: true,
          description: true,
          coverImage: {
            select: {
              id: true,
              url: true,
              nsfwLevel: true,
              type: true,
              metadata: true,
              width: true,
              height: true,
              name: true,
              hash: true,
            },
          },
          heroImage: {
            select: {
              id: true,
              url: true,
              nsfwLevel: true,
              type: true,
              metadata: true,
              width: true,
              height: true,
              name: true,
              hash: true,
            },
          },
          heroImagePosition: true,
          genre: true,
          nsfwLevel: true,
          updatedAt: true,
          user: {
            select: userWithCosmeticsSelect,
          },
          _count: {
            select: { engagements: true },
          },
          chapters: {
            where: { status: ComicChapterStatus.Published },
            select: {
              projectId: true,
              position: true,
              name: true,
              publishedAt: true,
              _count: {
                select: {
                  panels: {
                    where: {
                      status: ComicPanelStatus.Ready,
                      imageUrl: { not: null },
                    },
                  },
                },
              },
              panels: {
                where: {
                  status: ComicPanelStatus.Ready,
                  imageUrl: { not: null },
                },
                take: 1,
                orderBy: { position: 'asc' },
                select: { imageUrl: true },
              },
            },
            orderBy: { position: 'desc' },
          },
        },
      });

      let nextCursor: number | undefined;
      if (projects.length > limit) {
        const nextItem = projects.pop()!;
        nextCursor = nextItem.id;
      }

      const items = projects.map((p) => {
        const readyPanelCount = p.chapters.reduce((sum, ch) => sum + ch._count.panels, 0);
        const chapterCount = p.chapters.length;
        const thumbnailUrl =
          p.coverImage?.url ??
          p.chapters.flatMap((ch) => ch.panels).find((panel) => panel.imageUrl)?.imageUrl ??
          null;

        // Latest 3 published chapters
        const latestChapters = p.chapters.slice(0, 3).map((ch) => ({
          projectId: ch.projectId,
          position: ch.position,
          name: ch.name,
          publishedAt: ch.publishedAt,
        }));

        return {
          id: p.id,
          name: p.name,
          description: p.description,
          thumbnailUrl,
          coverImage: p.coverImage,
          heroImage: p.heroImage,
          genre: p.genre,
          nsfwLevel: p.nsfwLevel,
          readyPanelCount,
          chapterCount,
          latestChapters,
          followerCount: p._count.engagements,
          user: p.user,
          updatedAt: p.updatedAt,
        };
      });

      return { items, nextCursor };
    }),

  getPublicProjectForReader: comicPublicProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ input, ctx }) => {
      const isOwnerOrMod = ctx.user != null;

      const project = await dbRead.comicProject.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          name: true,
          description: true,
          userId: true,
          coverImage: { select: { id: true, url: true, nsfwLevel: true } },
          heroImage: { select: { id: true, url: true, nsfwLevel: true } },
          heroImagePosition: true,
          meta: true,
          genre: true,
          nsfwLevel: true,
          status: true,
          tosViolation: true,
          user: {
            select: userWithCosmeticsSelect,
          },
          chapters: {
            // Owners and mods see all chapters; public sees only published
            ...(!isOwnerOrMod ? { where: { status: ComicChapterStatus.Published } } : {}),
            orderBy: { position: 'asc' },
            select: {
              id: true,
              projectId: true,
              position: true,
              name: true,
              status: true,
              nsfwLevel: true,
              publishedAt: true,
              availability: true,
              earlyAccessConfig: true,
              earlyAccessEndsAt: true,
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
                  image: {
                    select: { id: true, nsfwLevel: true, hash: true, width: true, height: true },
                  },
                },
              },
            },
          },
        },
      });

      if (!project || project.status === ComicProjectStatus.Deleted) {
        throw throwNotFoundError('Comic not found');
      }

      // Block TOS-violated projects for non-owner, non-mod
      const isOwnerOrModViewer =
        ctx.user != null && (project.userId === ctx.user.id || ctx.user.isModerator === true);
      if (project.tosViolation && !isOwnerOrModViewer) {
        throw throwNotFoundError('Comic not found');
      }

      // Check if viewer is the owner or a moderator
      const canViewDrafts =
        ctx.user != null && (project.userId === ctx.user.id || ctx.user.isModerator === true);

      // Filter out draft chapters for non-owner, non-mod viewers
      // Also filter out chapters with no ready panels
      const filteredChapters = project.chapters.filter((ch) => {
        if (ch.panels.length === 0) return false;
        if (ch.status !== ComicChapterStatus.Published && !canViewDrafts) return false;
        return true;
      });

      if (filteredChapters.length === 0 && !canViewDrafts) {
        throw throwNotFoundError('Comic not found');
      }

      // Check early access for chapters that are currently in EA
      const now = new Date();
      const eaChapters = filteredChapters.filter(
        (ch) =>
          ch.availability === Availability.EarlyAccess &&
          ch.earlyAccessEndsAt &&
          ch.earlyAccessEndsAt > now
      );

      let accessMap = new Map<number, boolean>();
      if (eaChapters.length > 0 && !canViewDrafts) {
        const eaChapterIds = eaChapters.map((ch) => ch.id);
        const accessResults = await hasEntityAccess({
          entityType: 'ComicChapter',
          entityIds: eaChapterIds,
          userId: ctx.user?.id,
          isModerator: ctx.user?.isModerator,
        });
        for (const result of accessResults) {
          accessMap.set(result.entityId, result.hasAccess);
        }
      }

      const chapters = filteredChapters.map((ch) => {
        const isEa =
          ch.availability === Availability.EarlyAccess &&
          ch.earlyAccessEndsAt &&
          ch.earlyAccessEndsAt > now;
        const isLocked = isEa && !canViewDrafts && !accessMap.get(ch.id);
        const eaConfig = ch.earlyAccessConfig as {
          buzzPrice: number;
          timeframe: number;
        } | null;

        return {
          id: ch.id,
          projectId: ch.projectId,
          position: ch.position,
          name: ch.name,
          status: ch.status,
          nsfwLevel: ch.nsfwLevel,
          publishedAt: ch.publishedAt,
          availability: ch.availability,
          earlyAccessConfig: eaConfig,
          earlyAccessEndsAt: ch.earlyAccessEndsAt,
          panelCount: ch.panels.length,
          // Strip panels server-side for locked EA chapters (security)
          panels: isLocked ? [] : ch.panels,
        };
      });

      // Aggregate tip total from BuzzTip table
      const tipResult = await dbRead.$queryRaw<[{ total: number }]>`
        SELECT COALESCE(SUM(amount), 0)::int AS total
        FROM "BuzzTip"
        WHERE "entityType" = 'ComicProject' AND "entityId" = ${project.id}
      `;
      const tippedAmountCount = tipResult?.[0]?.total ?? 0;

      return {
        id: project.id,
        name: project.name,
        description: project.description,
        nsfwLevel: project.nsfwLevel,
        meta: parseComicProjectMeta(project.meta),
        coverImage: project.coverImage,
        heroImage: project.heroImage,
        heroImagePosition: project.heroImagePosition,
        user: project.user,
        isOwnerOrMod: canViewDrafts,
        tosViolation: project.tosViolation,
        tippedAmountCount,
        chapters,
      };
    }),

  // Dynamic pricing — whatIf cost estimate for panel generation
  /**
   * Unified cost estimation for all comic generation operations:
   * - Panel creation (from project page)
   * - Enhance panel (img2img with source)
   * - Iterative editor (with references and source images)
   * - Smart create (bulk panels)
   */
  getGenerationCostEstimate: comicProtectedProcedure
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

        const dims = getAspectRatioDimensions(aspectRatio, modelConfig);

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
          for (const refId of input.referenceIds) {
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

        const cappedImages = capReferenceImages(allImages, modelConfig.maxReferenceImages);

        const step = await createImageGenStep({
          params: {
            prompt: '',
            negativePrompt: '',
            engine: modelConfig.engine,
            baseModel: modelConfig.baseModel as any,
            width: dims.width,
            height: dims.height,
            aspectRatio,
            workflow: 'txt2img',
            sampler: 'Euler',
            steps: 25,
            quantity,
            draft: false,
            disablePoi: false,
            priority: 'low',
            sourceImage: null,
            images: cappedImages.length > 0 ? cappedImages : null,
          },
          resources: [{ id: effectiveVersionId, strength: 1 }],
          tags: ['comics'],
          tips: { creators: 0, civitai: 0 },
          whatIf: true,
          user: ctx.user! as SessionUser,
        });

        const workflow = await submitWorkflow({
          token,
          body: {
            steps: [step],
            currencies: ['yellow'],
          },
          query: { whatif: true },
        });

        return {
          cost: workflow.cost?.total ?? 0,
          ready: true,
        };
      } catch (error) {
        console.error('Comics getGenerationCostEstimate failed:', error);
        throw error;
      }
    }),

  getPromptEnhanceCostEstimate: comicProtectedProcedure.query(async ({ ctx }) => {
    try {
      const token = await getOrchestratorToken(ctx.user.id, ctx);
      return orchestratorChatCompletionCost({
        token,
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You enhance prompts.' },
          { role: 'user', content: 'A sample prompt for cost estimation.' },
        ],
        maxTokens: 512,
      });
    } catch (error) {
      console.error('Comics getPromptEnhanceCostEstimate failed:', error);
      return { cost: 0, ready: false };
    }
  }),

  /** Enhances a prompt via LLM and returns the enhanced text without generating an image. */
  enhancePromptText: comicProtectedProcedure
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
      });

      return { enhancedPrompt };
    }),

  getPlanChapterCostEstimate: comicProtectedProcedure.query(async ({ ctx }) => {
    try {
      const token = await getOrchestratorToken(ctx.user.id, ctx);
      return orchestratorChatCompletionCost({
        token,
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You plan comic panels.' },
          { role: 'user', content: 'A sample story for cost estimation.' },
        ],
        maxTokens: 2048,
      });
    } catch (error) {
      console.error('Comics getPlanChapterCostEstimate failed:', error);
      return { cost: 0, ready: false };
    }
  }),

  createProject: comicProtectedProcedure
    .input(createProjectSchema)
    .mutation(async ({ ctx, input }) => {
      const project = await dbWrite.comicProject.create({
        data: {
          userId: ctx.user.id,
          name: input.name,
          description: input.description ?? null,
          genre: input.genre ?? null,
          heroImagePosition: input.heroImagePosition ?? 50,
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

      // Handle cover image
      if (input.coverUrl) {
        const image = await createImage({
          url: input.coverUrl,
          type: 'image',
          userId: ctx.user.id,
        });
        await dbWrite.comicProject.update({
          where: { id: project.id },
          data: { coverImageId: image.id },
        });
      }

      // Handle hero image
      if (input.heroUrl) {
        const image = await createImage({
          url: input.heroUrl,
          type: 'image',
          userId: ctx.user.id,
        });
        await dbWrite.comicProject.update({
          where: { id: project.id },
          data: { heroImageId: image.id },
        });
      }

      await comicsSearchIndex.queueUpdate([
        { id: project.id, action: SearchIndexUpdateQueueAction.Update },
      ]);

      return project;
    }),

  deleteProject: comicProtectedProcedure
    .input(getProjectSchema)
    .mutation(async ({ ctx, input }) => {
      const project = await dbRead.comicProject.findUnique({
        where: { id: input.id },
        select: { userId: true },
      });
      if (!project || project.userId !== ctx.user.id) {
        throw throwAuthorizationError();
      }

      await dbWrite.comicProject.update({
        where: { id: input.id },
        data: { status: ComicProjectStatus.Deleted },
      });

      await comicsSearchIndex.queueUpdate([
        { id: input.id, action: SearchIndexUpdateQueueAction.Delete },
      ]);

      return { success: true };
    }),

  updateProject: comicProtectedProcedure
    .input(updateProjectSchema)
    .mutation(async ({ ctx, input }) => {
      const project = await dbRead.comicProject.findUnique({
        where: { id: input.id },
        select: { userId: true },
      });
      if (!project || project.userId !== ctx.user.id) {
        throw throwAuthorizationError();
      }

      const data: Record<string, any> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.description !== undefined) data.description = input.description;
      if (input.genre !== undefined) data.genre = input.genre;
      if (input.baseModel !== undefined) data.baseModel = input.baseModel;
      if (input.heroImagePosition !== undefined) data.heroImagePosition = input.heroImagePosition;
      if (input.meta !== undefined) data.meta = input.meta;

      // Cover image: accept either an existing Image ID or a CF URL (creates Image record)
      if (input.coverImageId !== undefined) {
        data.coverImageId = input.coverImageId;
      } else if (input.coverUrl !== undefined) {
        if (input.coverUrl) {
          const image = await createImage({
            url: input.coverUrl,
            type: 'image',
            userId: ctx.user.id,
          });
          data.coverImageId = image.id;
        } else {
          data.coverImageId = null;
        }
      }

      // Hero image: accept either an existing Image ID or a CF URL (creates Image record)
      if (input.heroImageId !== undefined) {
        data.heroImageId = input.heroImageId;
      } else if (input.heroUrl !== undefined) {
        if (input.heroUrl) {
          const image = await createImage({
            url: input.heroUrl,
            type: 'image',
            userId: ctx.user.id,
          });
          data.heroImageId = image.id;
        } else {
          data.heroImageId = null;
        }
      }

      const updated = await dbWrite.comicProject.update({
        where: { id: input.id },
        data,
      });

      await comicsSearchIndex.queueUpdate([
        { id: input.id, action: SearchIndexUpdateQueueAction.Update },
      ]);

      return updated;
    }),

  // Chapters
  createChapter: comicProtectedProcedure
    .input(createChapterSchema)
    .use(isProjectOwner)
    .mutation(async ({ input }) => {
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

      const updated = await dbWrite.comicChapter.update({
        where: {
          projectId_position: { projectId: input.projectId, position: input.chapterPosition },
        },
        data: { name: input.name },
      });

      return updated;
    }),

  deleteChapter: comicProtectedProcedure
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
                  projectId_position: { projectId: input.projectId, position: remaining[i].position },
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

        // Clear stale readChapters since positions may have shifted
        await tx.comicProjectEngagement.updateMany({
          where: { projectId: input.projectId, readChapters: { isEmpty: false } },
          data: { readChapters: [] },
        });
      });

      // Recalculate project NSFW level after chapter removal
      updateComicProjectNsfwLevels([input.projectId]).catch((e) =>
        console.error(`Failed to update project NSFW after chapter delete:`, e)
      );

      return { success: true };
    }),

  duplicatePanel: comicProtectedProcedure
    .input(duplicatePanelSchema)
    .mutation(async ({ ctx, input }) => {
      const panel = await dbRead.comicPanel.findUnique({
        where: { id: input.panelId },
        include: {
          chapter: { include: { project: { select: { userId: true } } } },
          references: { select: { referenceId: true } },
        },
      });

      if (!panel || panel.chapter.project.userId !== ctx.user!.id) {
        throw throwAuthorizationError();
      }

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
            metadata: panel.metadata ?? undefined,
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

      return newPanel;
    }),

  duplicateChapter: comicProtectedProcedure
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
            include: { references: { select: { referenceId: true } } },
          },
        },
      });

      if (!chapter || chapter.project.userId !== ctx.user!.id) {
        throw throwAuthorizationError();
      }

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
            where: { projectId_position: { projectId: input.projectId, position: TEMP_OFFSET + ch.position } },
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
              metadata: panel.metadata ?? undefined,
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

        // Clear stale readChapters engagement data
        await tx.comicProjectEngagement.updateMany({
          where: { projectId: input.projectId, readChapters: { isEmpty: false } },
          data: { readChapters: [] },
        });

        return created;
      });

      return newChapter;
    }),

  reorderChapters: comicProtectedProcedure
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
        // Phase 3: Clear all readChapters for this project (positions are now stale)
        await tx.comicProjectEngagement.updateMany({
          where: { projectId, readChapters: { isEmpty: false } },
          data: { readChapters: [] },
        });
      });

      return { success: true };
    }),

  // References — single creation path (images added separately)

  createReference: comicProtectedProcedure
    .input(createReferenceSchema)
    .mutation(async ({ ctx, input }) => {
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
            include: { image: { select: { id: true, url: true, width: true, height: true } } },
          },
        },
      });

      return updated;
    }),

  // Poll reference status — just return current status + images
  pollReferenceStatus: comicProtectedProcedure
    .input(z.object({ referenceId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      // Use dbWrite for read-after-write consistency when polling after mutations
      const reference = await dbWrite.comicReference.findUnique({
        where: { id: input.referenceId },
        include: {
          images: {
            orderBy: { position: 'asc' },
            include: {
              image: {
                select: { id: true, url: true, width: true, height: true, ingestion: true },
              },
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
        images: reference.images,
      };
    }),

  // Panels — generation via createImageGen (model determined by project)
  createPanel: comicProtectedProcedure
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

      if (generationReferenceIds.length > 0) {
        const allRefImages: { imageId: number; url: string; width: number; height: number }[] = [];

        for (const refId of generationReferenceIds) {
          const { referenceName, refImages: imgs } = await getReferenceImages(refId);
          if (!primaryReferenceName && referenceName) primaryReferenceName = referenceName;
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
        if (
          (error as any)?.code === 'BAD_REQUEST' ||
          (error as any)?.code === 'TOO_MANY_REQUESTS'
        )
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
        const result = await createImageGen({
          params: {
            prompt: fullPrompt,
            negativePrompt: '',
            engine: modelConfig.engine,
            baseModel: modelConfig.baseModel as any,
            width: panelWidth,
            height: panelHeight,
            aspectRatio: input.aspectRatio,
            workflow: 'txt2img',
            sampler: 'Euler',
            steps: 25,
            quantity: input.quantity,
            draft: false,
            disablePoi: false,
            priority: 'low',
            sourceImage: null,
            images: capReferenceImages(allImages, modelConfig.maxReferenceImages),
          },
          resources: [{ id: modelConfig.versionId, strength: 1 }],
          tags: ['comics'],
          tips: { creators: 0, civitai: 0 },
          user: ctx.user! as SessionUser,
          token,
          currencies: ['yellow'],
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
        return updated;
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
        return updated;
      }
    }),

  updatePanel: comicProtectedProcedure.input(updatePanelSchema).mutation(async ({ ctx, input }) => {
    // Verify ownership via chapter -> project
    const panel = await dbRead.comicPanel.findUnique({
      where: { id: input.panelId },
      include: { chapter: { include: { project: { select: { userId: true } } } } },
    });

    if (!panel || panel.chapter.project.userId !== ctx.user.id) {
      throw throwAuthorizationError();
    }

    const updated = await dbWrite.comicPanel.update({
      where: { id: input.panelId },
      data: {
        status: input.status,
        imageUrl: input.imageUrl,
        civitaiJobId: input.civitaiJobId,
        errorMessage: input.errorMessage,
      },
    });

    return updated;
  }),

  replacePanelImage: comicProtectedProcedure
    .input(z.object({ panelId: z.number().int(), imageUrl: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const panel = await dbRead.comicPanel.findUnique({
        where: { id: input.panelId },
        include: { chapter: { include: { project: { select: { userId: true, id: true } } } } },
      });
      if (!panel || panel.chapter.project.userId !== ctx.user.id) {
        throw throwAuthorizationError();
      }

      const image = await createImage({
        url: input.imageUrl,
        type: 'image',
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
      updateComicChapterNsfwLevels([panel.chapter.project.id]).catch(() => {});
      updateComicProjectNsfwLevels([panel.chapter.project.id]).catch(() => {});

      return updated;
    }),

  deletePanel: comicProtectedProcedure.input(deletePanelSchema).mutation(async ({ ctx, input }) => {
    // Verify ownership via chapter -> project
    const panel = await dbRead.comicPanel.findUnique({
      where: { id: input.panelId },
      include: { chapter: { include: { project: { select: { userId: true } } } } },
    });

    if (!panel || panel.chapter.project.userId !== ctx.user.id) {
      throw throwAuthorizationError();
    }

    await dbWrite.comicPanel.delete({
      where: { id: input.panelId },
    });

    // Recalculate NSFW levels after panel removal
    // Project NSFW is derived from chapter NSFW, so chapter must update first
    updateComicChapterNsfwLevels([panel.projectId])
      .then(() => updateComicProjectNsfwLevels([panel.projectId]))
      .catch((e) => console.error(`Failed to update NSFW levels after panel delete:`, e));

    return { success: true };
  }),

  reorderPanels: comicProtectedProcedure
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
          references: {
            include: {
              reference: {
                select: {
                  id: true,
                  name: true,
                  images: {
                    orderBy: { position: 'asc' },
                    include: {
                      image: { select: { id: true, url: true, width: true, height: true } },
                    },
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
              jobs: (step.jobs ?? []).map((job: any) => ({
                id: job.id,
                status: job.status,
                queuePosition: job.queuePosition,
              })),
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
          imageUrl: panel.imageUrl,
          workflowId: panel.workflowId,
          errorMessage: panel.errorMessage,
          metadata: panel.metadata,
          createdAt: panel.createdAt,
          updatedAt: panel.updatedAt,
        },
        project: {
          baseModel: panel.chapter.project.baseModel,
        },
        references: panelReferences.map((ref) => ({
          id: ref.id,
          name: ref.name,
          images: ref.images,
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
    .input(z.object({ panelId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      // Use dbWrite for read-after-write consistency when polling after mutations
      const panel = await dbWrite.comicPanel.findUnique({
        where: { id: input.panelId },
        include: { chapter: { include: { project: { select: { userId: true } } } } },
      });

      if (!panel || panel.chapter.project.userId !== ctx.user!.id) {
        throw throwAuthorizationError();
      }

      // Only poll if panel is actively generating with a workflow
      if (
        !panel.workflowId ||
        panel.status === ComicPanelStatus.Ready ||
        panel.status === ComicPanelStatus.Failed ||
        panel.status === ComicPanelStatus.AwaitingSelection
      ) {
        return { id: panel.id, status: panel.status, imageUrl: panel.imageUrl, errorMessage: panel.errorMessage };
      }

      // Backstop timeout: orchestrator step timeout is 21 min, use 25 min as hard cap
      const GENERATION_TIMEOUT = 25 * 60 * 1000;
      if (panel.createdAt.getTime() < Date.now() - GENERATION_TIMEOUT) {
        const updated = await dbWrite.comicPanel.update({
          where: { id: panel.id },
          data: {
            status: ComicPanelStatus.Failed,
            errorMessage: 'Generation timed out',
          },
        });
        sendComicPanelSignal(ctx.user!.id, {
          panelId: updated.id,
          projectId: panel.projectId,
          status: updated.status,
        });
        return { id: updated.id, status: updated.status, imageUrl: updated.imageUrl, errorMessage: updated.errorMessage };
      }

      // Check orchestrator status
      try {
        const token = await getOrchestratorToken(ctx.user!.id, ctx);
        const workflow = await getWorkflow({
          token,
          path: { workflowId: panel.workflowId },
        });

        // Extract image URL from first step output
        const steps = workflow.steps ?? [];
        const firstStep = steps[0] as any;
        const imageUrl =
          firstStep?.output?.images?.[0]?.url ?? firstStep?.output?.blobs?.[0]?.url ?? null;



        // Only download the image once the workflow has fully succeeded.
        // The URL can appear in step output before the image is actually available,
        // causing 404 errors if we try to fetch it too early.
        if (workflow.status === 'succeeded' && imageUrl) {
          // Extract dimensions from panel metadata (set during creation)
          const genParams = (panel.metadata as any)?.generationParams;
          const imgWidth = genParams?.width ?? getAspectRatioDimensions(DEFAULT_ASPECT_RATIO).width;
          const imgHeight =
            genParams?.height ?? getAspectRatioDimensions(DEFAULT_ASPECT_RATIO).height;

          // Check if multi-image generation (quantity > 1)
          const panelQuantity = (panel.metadata as any)?.quantity ?? 1;
          const outputImages = firstStep?.output?.images ?? firstStep?.output?.blobs ?? [];

          // Multi-image: upload all candidates and let user pick
          if (panelQuantity > 1 && outputImages.length > 1) {
            const candidateImages: { key: string }[] = [];
            const s3Multi = getS3Client('image');

            for (const candidateImg of outputImages) {
              if (!candidateImg?.url) continue;
              try {
                const resp = await fetch(candidateImg.url);
                if (!resp.ok) continue;
                const buf = Buffer.from(await resp.arrayBuffer());
                const s3Key = randomUUID();
                await s3Multi.send(
                  new PutObjectCommand({
                    Bucket: env.S3_IMAGE_UPLOAD_BUCKET,
                    Key: s3Key,
                    Body: buf,
                    ContentType: resp.headers.get('content-type') || 'image/jpeg',
                  })
                );
                candidateImages.push({ key: s3Key });
              } catch (e) {
                console.error(`Failed to upload candidate image for panel ${panel.id}:`, e);
              }
            }

            if (candidateImages.length === 0) {
              // All candidate uploads failed — mark panel as failed
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
              return { id: failed.id, status: failed.status, imageUrl: null, errorMessage: failed.errorMessage };
            }

            if (candidateImages.length > 1) {
              // Store candidates in metadata and transition to AwaitingSelection
              const updatedMeta = { ...(panel.metadata as any), candidateImages };
              const updated = await dbWrite.comicPanel.update({
                where: { id: panel.id },
                data: { metadata: updatedMeta, status: ComicPanelStatus.AwaitingSelection },
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
                candidateImages: candidateImages.map((c) => c.key),
              };
            }
            // Fall through to single-image handling if only 1 candidate survived
          }

          // Single-image path (or multi-image with only 1 result)
          let s3ImageKey: string;
          try {
            const imageResponse = await fetch(imageUrl);
            if (!imageResponse.ok)
              throw new Error(`Failed to download: ${imageResponse.status}`);
            const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

            s3ImageKey = randomUUID();
            const s3 = getS3Client('image');
            await s3.send(
              new PutObjectCommand({
                Bucket: env.S3_IMAGE_UPLOAD_BUCKET,
                Key: s3ImageKey,
                Body: imageBuffer,
                ContentType: imageResponse.headers.get('content-type') || 'image/jpeg',
              })
            );
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
            return { id: panel.id, status: ComicPanelStatus.Failed, imageUrl: null, errorMessage: 'Image upload failed. Please regenerate.' };
          }

          // Create Image record via standard pipeline (ingestion + flags)
          const image = await createImage({
            url: s3ImageKey,
            type: 'image',
            userId: ctx.user!.id,
            width: imgWidth,
            height: imgHeight,
            meta: { prompt: panel.prompt } as any,
          });

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

          return { id: updated.id, status: updated.status, imageUrl: updated.imageUrl, errorMessage: null };
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
          return { id: updated.id, status: updated.status, imageUrl: updated.imageUrl, errorMessage: null };
        }

        if (workflow.status === 'failed' || workflow.status === 'canceled') {
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
          return { id: updated.id, status: updated.status, imageUrl: updated.imageUrl, errorMessage: updated.errorMessage };
        }
      } catch (error) {
        // If we can't check the workflow, don't fail the poll - just return current state
        console.error('Failed to poll workflow status:', error);
      }

      // Still processing - return as-is
      return { id: panel.id, status: panel.status, imageUrl: panel.imageUrl, errorMessage: panel.errorMessage };
    }),

  selectPanelImage: comicProtectedProcedure
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
      const candidates: { key: string }[] = meta?.candidateImages ?? [];
      if (!candidates.some((c) => c.key === input.selectedImageKey)) {
        throw throwBadRequestError('Selected image is not among candidates');
      }

      const genParams = meta?.generationParams;
      const imgWidth = genParams?.width ?? getAspectRatioDimensions(DEFAULT_ASPECT_RATIO).width;
      const imgHeight = genParams?.height ?? getAspectRatioDimensions(DEFAULT_ASPECT_RATIO).height;

      // Create Image record for the selected candidate
      const image = await createImage({
        url: input.selectedImageKey,
        type: 'image',
        userId: ctx.user!.id,
        width: imgWidth,
        height: imgHeight,
        meta: { prompt: panel.prompt } as any,
      });

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

      return updated;
    }),

  // Iterative panel editor — generate image without creating a panel record
  iterateGenerate: comicProtectedProcedure
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
      const allRefImages: { imageId: number; url: string; width: number; height: number }[] = [];
      for (const refId of generationReferenceIds) {
        const { referenceName, refImages: imgs } = await getReferenceImages(refId);
        if (!primaryReferenceName && referenceName) primaryReferenceName = referenceName;
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

      const result = await createImageGen({
        params: {
          prompt: fullPrompt || '',
          negativePrompt: '',
          engine: modelConfig.engine,
          baseModel: modelConfig.baseModel as any,
          width: panelWidth,
          height: panelHeight,
          aspectRatio: input.aspectRatio,
          workflow: 'txt2img',
          sampler: 'Euler',
          steps: 25,
          quantity: input.quantity,
          draft: false,
          disablePoi: false,
          priority: 'low',
          sourceImage: null,
          images: capReferenceImages(allImages, modelConfig.maxReferenceImages),
        },
        resources: [{ id: effectiveVersionId, strength: 1 }],
        tags: ['comics'],
        tips: { creators: 0, civitai: 0 },
        user: ctx.user! as SessionUser,
        token,
        currencies: ['yellow'],
      });

      return {
        workflowId: result.id,
        width: panelWidth,
        height: panelHeight,
        cost: result.cost?.total ?? 0,
        enhancedPrompt: null,
      };
    }),

  // Iterative panel editor — poll workflow status without panel involvement
  pollIterationStatus: comicProtectedProcedure
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
  planChapterPanels: comicProtectedProcedure
    .input(planChapterPanelsSchema)
    .use(isProjectOwner)
    .mutation(async ({ ctx, input }) => {
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
        });
      } catch (error) {
        throw throwBadRequestError(getOrchestratorErrorMessage(error));
      }
    }),

  // Smart Create — Create chapter with all panels at once
  smartCreateChapter: comicProtectedProcedure
    .input(smartCreateChapterSchema)
    .use(isProjectOwner)
    .mutation(async ({ ctx, input }) => {
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

      // Get all user's ready references, then narrow to only those relevant
      // to this comic to prevent cross-comic reference bleeding.
      const allUserRefs = await dbRead.comicReference.findMany({
        where: { userId: ctx.user!.id, status: ComicReferenceStatus.Ready },
        select: { id: true, name: true },
      });

      // Only include references explicitly passed via referenceIds
      const allowedRefIds = new Set(allUserRefs.map((r) => r.id));
      if (input.referenceIds && input.referenceIds.some((id) => !allowedRefIds.has(id))) {
        throw throwAuthorizationError();
      }

      // Filter to references that are either explicitly provided via referenceIds
      // or @-mentioned in the story description. This prevents Smart Create from
      // pulling in characters from other comics that happen to share the user.
      const { mentionedIds: storyMentionedIds } = resolveReferenceMentions({
        prompt: input.storyDescription,
        references: allUserRefs,
      });
      const relevantRefIds = new Set([
        ...storyMentionedIds,
        ...(input.referenceIds ?? []),
      ]);
      const relevantRefs = allUserRefs.filter((r) => relevantRefIds.has(r.id));

      // Pre-load reference images keyed by refId (only used for panels that @mention them)
      const refImagesByRefId = new Map<
        number,
        { referenceName: string; images: { url: string; width: number; height: number }[] }
      >();
      for (const ref of relevantRefs) {
        const { referenceName, refImages: imgs } = await getReferenceImages(ref.id);
        refImagesByRefId.set(ref.id, {
          referenceName: referenceName ?? ref.name,
          images: imgs.map(({ url, width, height }) => ({ url, width, height })),
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
        const panelPrimaryRefName =
          mentionedIds.length > 0
            ? (refImagesByRefId.get(mentionedIds[0])?.referenceName ?? '')
            : '';
        const mentionedRefNames = mentionedIds.map(
          (id) => refImagesByRefId.get(id)?.referenceName ?? ''
        ).filter(Boolean);

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
        panels: createdPanels,
      };
    }),

  // ──── Phase 3: Publish/Unpublish ────

  publishChapter: comicProtectedProcedure
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
      await updateComicChapterNsfwLevels([input.projectId]);
      await updateComicProjectNsfwLevels([input.projectId]);

      const isScheduled = input.scheduledAt && input.scheduledAt > new Date();
      const isFirstPublish = chapter.status === ComicChapterStatus.Draft;

      const updated = await dbWrite.comicChapter.update({
        where: {
          projectId_position: { projectId: input.projectId, position: input.chapterPosition },
        },
        data: {
          status: isScheduled ? ComicChapterStatus.Scheduled : ComicChapterStatus.Published,
          publishedAt: isScheduled ? input.scheduledAt : new Date(),
          ...(input.earlyAccessConfig !== undefined
            ? { earlyAccessConfig: input.earlyAccessConfig ?? undefined }
            : {}),
        },
      });

      // For scheduled chapters, skip notifications and project publish until the scheduled time
      if (isScheduled) {
        return updated;
      }

      // Set project publishedAt on first ever chapter publish
      if (!chapter.project.publishedAt) {
        await dbWrite.comicProject.update({
          where: { id: chapter.project.id },
          data: { publishedAt: new Date() },
        });
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
      await comicsSearchIndex.queueUpdate([
        { id: input.projectId, action: SearchIndexUpdateQueueAction.Update },
      ]);

      return updated;
    }),

  unpublishChapter: comicProtectedProcedure
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
        },
      });

      // Update search index — unpublishing may affect discoverability
      await comicsSearchIndex.queueUpdate([
        { id: input.projectId, action: SearchIndexUpdateQueueAction.Update },
      ]);

      return updated;
    }),

  purchaseChapterAccess: comicProtectedProcedure
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
        const data = await createMultiAccountBuzzTransaction({
          fromAccountId: ctx.user.id,
          toAccountId: chapter.project.userId,
          amount: eaConfig.buzzPrice,
          type: TransactionType.Purchase,
          description: `Early access: ${chapter.project.name} - ${chapter.name}`,
          details: { comicChapterId: chapter.id, earlyAccessPurchase: true },
          externalTransactionIdPrefix,
          fromAccountTypes: ['yellow'],
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
          status: true,
          earlyAccessConfig: true,
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

      return dbWrite.comicChapter.update({
        where: {
          projectId_position: { projectId: input.projectId, position: input.chapterPosition },
        },
        data: {
          earlyAccessConfig: input.earlyAccessConfig ?? undefined,
        },
      });
    }),

  // ──── Moderator Tools ────

  setTosViolation: comicModeratorProcedure
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
      await comicsSearchIndex.queueUpdate([
        {
          id: input.id,
          action: !project.tosViolation
            ? SearchIndexUpdateQueueAction.Delete
            : SearchIndexUpdateQueueAction.Update,
        },
      ]);

      return { success: true, tosViolation: !project.tosViolation };
    }),

  moderatorUnpublishChapter: comicModeratorProcedure
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

      await comicsSearchIndex.queueUpdate([
        { id: input.projectId, action: SearchIndexUpdateQueueAction.Update },
      ]);

      return { success: true };
    }),

  // ──── Phase 3: Comic Engagement (Follow/Hide) ────

  toggleComicEngagement: comicProtectedProcedure
    .input(
      z.object({
        projectId: z.number().int(),
        type: z.nativeEnum(ComicEngagementType),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const engagement = await dbRead.comicProjectEngagement.findUnique({
        where: { userId_projectId: { userId: ctx.user.id, projectId: input.projectId } },
      });

      if (engagement) {
        if (engagement.type === input.type) {
          // Same type — toggle off. Set to None instead of deleting if there are readChapters.
          if (engagement.readChapters.length > 0) {
            await dbWrite.comicProjectEngagement.update({
              where: { userId_projectId: { userId: ctx.user.id, projectId: input.projectId } },
              data: { type: ComicEngagementType.None },
            });
          } else {
            await dbWrite.comicProjectEngagement.delete({
              where: { userId_projectId: { userId: ctx.user.id, projectId: input.projectId } },
            });
          }
          return false;
        } else {
          // Different type — switch
          await dbWrite.comicProjectEngagement.update({
            where: { userId_projectId: { userId: ctx.user.id, projectId: input.projectId } },
            data: { type: input.type, createdAt: new Date() },
          });
          return true;
        }
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
    .input(z.object({ projectId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const engagement = await dbRead.comicProjectEngagement.findUnique({
        where: { userId_projectId: { userId: ctx.user.id, projectId: input.projectId } },
      });
      if (!engagement || engagement.type === ComicEngagementType.None) return null;
      return engagement.type;
    }),

  // ──── Phase 3: Chapter Read Tracking (via engagement readChapters) ────

  markChapterRead: comicProtectedProcedure
    .input(z.object({ projectId: z.number().int(), chapterPosition: z.number().int().min(0) }))
    .mutation(async ({ ctx, input }) => {
      const { projectId, chapterPosition } = input;
      const userId = ctx.user.id;
      await dbWrite.$executeRaw`
        INSERT INTO "ComicProjectEngagement" ("userId", "projectId", "type", "readChapters", "createdAt")
        VALUES (${userId}, ${projectId}, 'None', ARRAY[${chapterPosition}]::integer[], NOW())
        ON CONFLICT ("userId", "projectId")
        DO UPDATE SET "readChapters" = array_append(
          array_remove("ComicProjectEngagement"."readChapters", ${chapterPosition}),
          ${chapterPosition}
        )
      `;
      return { success: true };
    }),

  getChapterReadStatus: comicProtectedProcedure
    .input(z.object({ projectId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const engagement = await dbRead.comicProjectEngagement.findUnique({
        where: { userId_projectId: { userId: ctx.user.id, projectId: input.projectId } },
        select: { readChapters: true },
      });
      return engagement?.readChapters ?? [];
    }),

  markChapterUnread: comicProtectedProcedure
    .input(z.object({ projectId: z.number().int(), chapterPosition: z.number().int().min(0) }))
    .mutation(async ({ ctx, input }) => {
      const { projectId, chapterPosition } = input;
      const userId = ctx.user.id;
      await dbWrite.$executeRaw`
        UPDATE "ComicProjectEngagement"
        SET "readChapters" = array_remove("readChapters", ${chapterPosition})
        WHERE "userId" = ${userId} AND "projectId" = ${projectId}
      `;
      return { success: true };
    }),

  // ──── Enhance Panel: create from existing image, optionally with img2img ────

  enhancePanel: comicProtectedProcedure
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

        return panel;
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
      const allRefImages: { imageId: number; url: string; width: number; height: number }[] = [];
      for (const refId of generationReferenceIds) {
        const { referenceName, refImages: imgs } = await getReferenceImages(refId);
        if (!primaryReferenceName && referenceName) primaryReferenceName = referenceName;
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
        if (refPanel && refPanel.chapter.projectId === input.projectId && refPanel.status === ComicPanelStatus.Ready && refPanel.imageUrl) {
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
        const result = await createImageGen({
          params: {
            prompt: fullPrompt || '',
            negativePrompt: '',
            engine: modelConfig.engine,
            baseModel: modelConfig.baseModel as any,
            width: panelWidth,
            height: panelHeight,
            aspectRatio: input.aspectRatio,
            workflow: 'txt2img',
            sampler: 'Euler',
            steps: 25,
            quantity: 1,
            draft: false,
            disablePoi: false,
            priority: 'low',
            sourceImage: null,
            images: capReferenceImages(allImages, modelConfig.maxReferenceImages),
          },
          resources: [{ id: effectiveVersionId, strength: 1 }],
          tags: ['comics'],
          tips: { creators: 0, civitai: 0 },
          user: ctx.user! as SessionUser,
          token,
          currencies: ['yellow'],
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
        return updated;
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
        return updated;
      }
    }),

  // ──── Bulk Create Panels ────

  bulkCreatePanels: comicProtectedProcedure
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

      const bulkModelConfig = getComicModelConfig(input.baseModel ?? chapter.project.baseModel);

      // Get next position after existing panels
      const lastPanel = await dbWrite.comicPanel.findFirst({
        where: { projectId: input.projectId, chapterPosition: input.chapterPosition },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      let nextPosition = (lastPanel?.position ?? -1) + 1;

      // Get all user's ready references (needed for generated panels)
      const allUserRefs = await dbRead.comicReference.findMany({
        where: { userId: ctx.user!.id, status: ComicReferenceStatus.Ready },
        select: { id: true, name: true },
      });
      const allReferenceNames = allUserRefs.map((r) => r.name);

      // Pre-load reference images keyed by refId (only used for panels that @mention them)
      const refImagesByRefId = new Map<
        number,
        { referenceName: string; images: { url: string; width: number; height: number }[] }
      >();
      for (const ref of allUserRefs) {
        const { referenceName, refImages: imgs } = await getReferenceImages(ref.id);
        refImagesByRefId.set(ref.id, {
          referenceName: referenceName ?? ref.name,
          images: imgs.map(({ url, width, height }) => ({ url, width, height })),
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
          const image = await dbRead.image.findUnique({
            where: { id: panelDef.imageId },
            select: { id: true, userId: true, url: true },
          });
          if (!image || image.userId !== ctx.user!.id) {
            throw throwAuthorizationError();
          }

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

          updateComicChapterNsfwLevels([input.projectId]).catch((e) =>
            console.error(`Failed to update chapter NSFW for project ${input.projectId}:`, e)
          );
          updateComicProjectNsfwLevels([input.projectId]).catch((e) =>
            console.error(`Failed to update project NSFW for project ${input.projectId}:`, e)
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
          const image = await createImage({
            url: panelDef.sourceImageUrl,
            type: 'image',
            userId: ctx.user!.id,
            width: panelDef.sourceImageWidth ?? 512,
            height: panelDef.sourceImageHeight ?? 512,
          });

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
          const panelPrimaryRefName =
            mentionedIds.length > 0
              ? (refImagesByRefId.get(mentionedIds[0])?.referenceName ?? '')
              : '';
          const mentionedRefNames = mentionedIds.map(
            (id) => refImagesByRefId.get(id)?.referenceName ?? ''
          ).filter(Boolean);

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
            ? (bulkModelConfig.img2imgVersionId ?? bulkModelConfig.versionId)
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
            const result = await createImageGen({
              params: {
                prompt: fullPrompt,
                negativePrompt: '',
                engine: bulkModelConfig.engine,
                baseModel: bulkModelConfig.baseModel as any,
                width: bulkPanelW,
                height: bulkPanelH,
                aspectRatio: panelDef.aspectRatio,
                workflow: 'txt2img',
                sampler: 'Euler',
                steps: 25,
                quantity: 1,
                draft: false,
                disablePoi: false,
                priority: 'low',
                sourceImage: null,
                images: capReferenceImages(allImages, bulkModelConfig.maxReferenceImages),
              },
              resources: [{ id: bulkVersionId, strength: 1 }],
              tags: ['comics'],
              tips: { creators: 0, civitai: 0 },
              user: ctx.user! as SessionUser,
              token: batchToken,
              currencies: ['yellow'],
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
          const panelPrimaryRefName =
            mentionedIds.length > 0
              ? (refImagesByRefId.get(mentionedIds[0])?.referenceName ?? '')
              : '';
          const mentionedRefNames = mentionedIds.map(
            (id) => refImagesByRefId.get(id)?.referenceName ?? ''
          ).filter(Boolean);

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

      return { panels: createdPanels };
    }),

  // ──── Phase 2: Create panel from existing Image (manual mode) ────

  createPanelFromImage: comicProtectedProcedure
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
      const image = await dbRead.image.findUnique({
        where: { id: input.imageId },
        select: { id: true, userId: true, url: true },
      });
      if (!image || image.userId !== ctx.user!.id) {
        throw throwAuthorizationError();
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
      updateComicChapterNsfwLevels([input.projectId]).catch((e) =>
        console.error(`Failed to update chapter NSFW for project ${input.projectId}:`, e)
      );
      updateComicProjectNsfwLevels([input.projectId]).catch((e) =>
        console.error(`Failed to update project NSFW for project ${input.projectId}:`, e)
      );

      return panel;
    }),

  // ──── Phase 4: Reference aliases ────

  getReference: comicProtectedProcedure
    .input(z.object({ referenceId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const reference = await dbRead.comicReference.findUnique({
        where: { id: input.referenceId },
        include: {
          images: {
            orderBy: { position: 'asc' },
            include: { image: { select: { id: true, url: true, width: true, height: true } } },
          },
        },
      });
      if (!reference || reference.userId !== ctx.user.id) {
        throw throwAuthorizationError();
      }
      return reference;
    }),

  deleteReference: comicProtectedProcedure
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
    .input(updateReferenceSchema)
    .mutation(async ({ ctx, input }) => {
      const reference = await dbRead.comicReference.findUnique({
        where: { id: input.referenceId },
        select: { userId: true },
      });
      if (!reference || reference.userId !== ctx.user.id) {
        throw throwAuthorizationError();
      }
      const updated = await dbWrite.comicReference.update({
        where: { id: input.referenceId },
        data: { name: input.name },
      });
      return updated;
    }),

  deleteReferenceImage: comicProtectedProcedure
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
            include: { image: { select: { id: true, url: true, width: true, height: true } } },
          },
        },
      });
      return references;
    }),

  // ──── Phase 7: Chapter Comments ────

  getChapterThread: comicPublicProcedure
    .input(z.object({ projectId: z.number().int(), chapterPosition: z.number().int().min(0) }))
    .query(async ({ input, ctx }) => {
      const thread = await dbRead.thread.findUnique({
        where: {
          comicProjectId_comicChapterPosition: {
            comicProjectId: input.projectId,
            comicChapterPosition: input.chapterPosition,
          },
        },
        select: {
          id: true,
          locked: true,
          commentCount: true,
          comments: {
            orderBy: { createdAt: 'asc' },
            where: ctx.user?.isModerator ? {} : { hidden: false },
            select: commentV2Select,
          },
        },
      });

      return thread;
    }),

  createChapterComment: comicProtectedProcedure
    .input(
      z.object({
        projectId: z.number().int(),
        chapterPosition: z.number().int().min(0),
        content: z.string().min(1).max(10000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Find or create thread for this chapter (upsert avoids race condition)
      const thread = await dbWrite.thread.upsert({
        where: {
          comicProjectId_comicChapterPosition: {
            comicProjectId: input.projectId,
            comicChapterPosition: input.chapterPosition,
          },
        },
        create: {
          comicProjectId: input.projectId,
          comicChapterPosition: input.chapterPosition,
        },
        update: {},
        select: { id: true, locked: true },
      });

      if (thread.locked) {
        throw throwBadRequestError('Comments are locked for this chapter');
      }

      const comment = await dbWrite.commentV2.create({
        data: {
          userId: ctx.user.id,
          content: input.content,
          threadId: thread.id,
        },
      });

      // Increment comment count
      await dbWrite.thread.update({
        where: { id: thread.id },
        data: { commentCount: { increment: 1 } },
      });

      // Notify the comic project owner (if commenter is not the owner)
      const project = await dbRead.comicProject.findUnique({
        where: { id: input.projectId },
        select: { userId: true, name: true },
      });
      const chapter = await dbRead.comicChapter.findUnique({
        where: {
          projectId_position: {
            projectId: input.projectId,
            position: input.chapterPosition,
          },
        },
        select: { name: true },
      });

      if (project && project.userId !== ctx.user.id) {
        createNotification({
          type: 'new-comic-comment',
          key: `new-comic-comment:${input.projectId}:${input.chapterPosition}:${comment.id}`,
          category: NotificationCategory.Comment,
          userId: project.userId,
          details: {
            comicProjectId: String(input.projectId),
            comicProjectName: project.name,
            chapterName: chapter?.name ?? `Chapter ${input.chapterPosition + 1}`,
            commenterUsername: ctx.user.username ?? 'Someone',
          },
        }).catch((e) => console.error('Failed to send comic comment notification:', e));
      }

      return comment;
    }),

  // ──── Project-scoped references ────

  addReferenceToProject: comicProtectedProcedure
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
            include: { image: { select: { id: true, url: true, width: true, height: true } } },
          },
          _count: { select: { images: true } },
        },
      });

      return references;
    }),

  // ──── Queue Status ────

  /**
   * Get the current queue status for the user.
   * Returns used slots, limit, available slots, and whether the user can generate.
   */
  getQueueStatus: comicProtectedProcedure.query(async ({ ctx }) => {
    const token = await getOrchestratorToken(ctx.user!.id, ctx);
    const userTier = ctx.user?.tier ?? 'free';
    return getUserQueueStatus(token, userTier);
  }),
});
