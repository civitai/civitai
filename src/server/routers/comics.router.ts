import { z } from 'zod';
import type { SessionUser } from 'next-auth';
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
import { createImageGen } from '~/server/services/orchestrator/imageGen/imageGen';
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
import {
  EntityAccessPermission,
  NotificationCategory,
  SearchIndexUpdateQueueAction,
} from '~/server/common/enums';
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

// Reference (character/location/item) creation — always global per user
const createReferenceSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((v) => !v.includes('@'), 'Name cannot contain @ character'),
  type: z.nativeEnum(ComicReferenceType).default(ComicReferenceType.Character),
  description: z.string().max(2000).optional(),
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

const comicModelEnum = z.enum(['NanoBanana', 'Flux2', 'Seedream', 'OpenAI', 'Qwen', 'Grok']);

const createPanelSchema = z.object({
  projectId: z.number().int(),
  chapterPosition: z.number().int().min(0),
  referenceIds: z.array(z.number().int()).optional(),
  selectedImageIds: z.array(z.number().int()).optional(),
  prompt: z.string().min(1).max(2000),
  enhance: z.boolean().default(true),
  useContext: z.boolean().default(true),
  includePreviousImage: z.boolean().default(false),
  position: z.number().int().min(0).optional(),
  aspectRatio: z.string().default('3:4'),
  baseModel: comicModelEnum.nullish(),
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

const planChapterPanelsSchema = z.object({
  projectId: z.number().int(),
  storyDescription: z.string().min(1).max(5000),
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
  enhance: z.boolean().default(true),
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
  enhance: z.boolean().default(true),
  useContext: z.boolean().default(true),
  includePreviousImage: z.boolean().default(false),
  position: z.number().int().min(0).optional(),
  aspectRatio: z.string().default('3:4'),
  baseModel: comicModelEnum.nullish(),
  // When true, always run AI generation even without a prompt (e.g. aspect ratio change, sketch annotations)
  forceGenerate: z.boolean().default(false),
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
        enhance: z.boolean().default(true),
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
    buzzPrice: z.number().int().min(1),
    timeframe: z.number().int().min(1).max(365),
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
  enhance: boolean;
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
}) {
  const {
    projectId,
    chapterPosition,
    referenceIds,
    prompt,
    enhance,
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
  } = args;

  const token = await getOrchestratorToken(userId, ctx);

  // Build prompt — optionally enhance via LLM
  let fullPrompt: string;
  if (enhance) {
    fullPrompt = await enhanceComicPrompt({
      token,
      userPrompt: prompt,
      characterName: primaryReferenceName,
      characterNames: allReferenceNames,
      previousPanel: contextPanel ?? undefined,
      storyContext,
    });
  } else {
    fullPrompt = prompt;
  }

  const metadata = {
    previousPanelId: contextPanel?.id ?? null,
    previousPanelPrompt: contextPanel ? contextPanel.enhancedPrompt ?? contextPanel.prompt : null,
    previousPanelImageUrl: contextPanel?.imageUrl ?? null,
    referenceImages: refImages,
    enhanceEnabled: enhance,
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

  const panel = await dbWrite.comicPanel.create({
    data: {
      projectId,
      chapterPosition,
      prompt,
      enhancedPrompt: enhance ? fullPrompt : null,
      position,
      status: ComicPanelStatus.Pending,
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

    const errorMessage = errorDetails.join(' | ');
    console.error('Comics panel generation failed:', {
      panelId: panel.id,
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
    });

    const updated = await dbWrite.comicPanel.update({
      where: { id: panel.id },
      data: { status: ComicPanelStatus.Failed, errorMessage },
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
    const project = await dbRead.comicProject.findUnique({
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

    // Fetch all user references (global — not project-specific)
    const references = await dbRead.comicReference.findMany({
      where: { userId: ctx.user.id },
      orderBy: { createdAt: 'asc' },
      include: {
        images: {
          orderBy: { position: 'asc' },
          include: { image: { select: { id: true, url: true, width: true, height: true } } },
        },
      },
    });

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
          isLocked: !!isLocked,
          panelCount: ch.panels.length,
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
  getPanelCostEstimate: comicProtectedProcedure
    .input(z.object({ baseModel: z.string().nullish() }).optional())
    .query(async ({ ctx, input }) => {
    try {
      const token = await getOrchestratorToken(ctx.user.id, ctx);
      const modelConfig = getComicModelConfig(input?.baseModel);

      const defaultDims = getAspectRatioDimensions(DEFAULT_ASPECT_RATIO, modelConfig);
      const step = await createImageGenStep({
        params: {
          prompt: '',
          negativePrompt: '',
          engine: modelConfig.engine,
          baseModel: modelConfig.baseModel as any,
          width: defaultDims.width,
          height: defaultDims.height,
          aspectRatio: DEFAULT_ASPECT_RATIO,
          workflow: 'txt2img',
          sampler: 'Euler',
          steps: 25,
          quantity: 1,
          draft: false,
          disablePoi: false,
          priority: 'low',
          sourceImage: null,
          images: null,
        },
        resources: [{ id: modelConfig.versionId, strength: 1 }],
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
      console.error('Comics getPanelCostEstimate failed:', error);
      return { cost: 0, ready: false };
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
      const reference = await dbRead.comicReference.findUnique({
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
      // Default to only the mentioned references (from the prompt), not all refs.
      let generationReferenceIds: number[];
      if (input.referenceIds && input.referenceIds.length > 0) {
        if (input.referenceIds.some((id) => !allowedRefIds.has(id))) {
          throw throwAuthorizationError();
        }
        generationReferenceIds = input.referenceIds;
      } else {
        generationReferenceIds =
          mentionedReferenceIds.length > 0
            ? mentionedReferenceIds
            : allUserRefs.map((r) => r.id);
      }

      if (generationReferenceIds.length === 0) {
        throw throwBadRequestError('No references available for generation');
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

      // Get reference images for generation
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

      if (combinedRefImages.length === 0) {
        throw throwBadRequestError('References have no reference images');
      }

      // Conditionally use previous panel context for prompt enhancement
      const effectiveContext = input.useContext ? contextPanel : null;
      const modelConfig = getComicModelConfig(input.baseModel ?? chapter.project.baseModel);
      const { width: panelWidth, height: panelHeight } = getAspectRatioDimensions(
        input.aspectRatio,
        modelConfig
      );

      const token = await getOrchestratorToken(ctx.user!.id, ctx);

      // Build prompt — optionally enhance via LLM
      let fullPrompt: string;
      if (input.enhance) {
        fullPrompt = await enhanceComicPrompt({
          token,
          userPrompt: input.prompt,
          characterName: primaryReferenceName,
          characterNames: allReferenceNames,
          previousPanel: effectiveContext ?? undefined,
        });
      } else {
        fullPrompt = input.prompt;
      }

      // Optionally include previous panel's image in generation
      const allImages = [...combinedRefImages];
      if (input.includePreviousImage && contextPanel?.imageUrl) {
        const prevEdgeUrl = getEdgeUrl(contextPanel.imageUrl, { original: true });
        allImages.push({ url: prevEdgeUrl, width: panelWidth, height: panelHeight });
      }

      // Build metadata for debugging and regeneration
      const metadata = {
        previousPanelId: effectiveContext?.id ?? null,
        previousPanelPrompt: effectiveContext
          ? effectiveContext.enhancedPrompt ?? effectiveContext.prompt
          : null,
        previousPanelImageUrl: contextPanel?.imageUrl ?? null,
        referenceImages: combinedRefImages,
        selectedImageIds: input.selectedImageIds ?? null,
        useContext: input.useContext,
        includePreviousImage: input.includePreviousImage,
        enhanceEnabled: input.enhance,
        primaryReferenceName,
        allReferenceNames,
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
          enhancedPrompt: input.enhance ? fullPrompt : null,
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
            quantity: 1,
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

        const errorMessage = errorDetails.join(' | ');
        console.error('Comics createPanel generation failed:', {
          panelId: panel.id,
          error: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
        });

        const updated = await dbWrite.comicPanel.update({
          where: { id: panel.id },
          data: {
            status: ComicPanelStatus.Failed,
            errorMessage,
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
    updateComicChapterNsfwLevels([panel.projectId]).catch((e) =>
      console.error(`Failed to update chapter NSFW after panel delete:`, e)
    );
    updateComicProjectNsfwLevels([panel.projectId]).catch((e) =>
      console.error(`Failed to update project NSFW after panel delete:`, e)
    );

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
      const panel = await dbRead.comicPanel.findUnique({
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
        panel.status === ComicPanelStatus.Failed
      ) {
        return { id: panel.id, status: panel.status, imageUrl: panel.imageUrl };
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
        return { id: updated.id, status: updated.status, imageUrl: updated.imageUrl };
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

          // Download from orchestrator and upload to S3 (standard image storage)
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
            return { id: panel.id, status: ComicPanelStatus.Failed, imageUrl: null };
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

          return { id: updated.id, status: updated.status, imageUrl: updated.imageUrl };
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
          return { id: updated.id, status: updated.status, imageUrl: updated.imageUrl };
        }

        if (workflow.status === 'failed' || workflow.status === 'canceled') {
          const updated = await dbWrite.comicPanel.update({
            where: { id: panel.id },
            data: {
              status: ComicPanelStatus.Failed,
              errorMessage: `Generation ${workflow.status} — buzz has been refunded`,
            },
          });
          return { id: updated.id, status: updated.status, imageUrl: updated.imageUrl };
        }
      } catch (error) {
        // If we can't check the workflow, don't fail the poll - just return current state
        console.error('Failed to poll workflow status:', error);
      }

      // Still processing - return as-is
      return { id: panel.id, status: panel.status, imageUrl: panel.imageUrl };
    }),

  // Smart Create — Plan chapter panels via GPT
  planChapterPanels: comicProtectedProcedure
    .input(planChapterPanelsSchema)
    .use(isProjectOwner)
    .mutation(async ({ ctx, input }) => {
      const token = await getOrchestratorToken(ctx.user!.id, ctx);

      // Get all user's reference names for story planning
      const allUserRefs = await dbRead.comicReference.findMany({
        where: { userId: ctx.user!.id, status: ComicReferenceStatus.Ready },
        select: { name: true },
      });

      return planChapterPanels({
        token,
        storyDescription: input.storyDescription,
        characterNames: allUserRefs.map((r) => r.name),
      });
    }),

  // Smart Create — Create chapter with all panels at once
  smartCreateChapter: comicProtectedProcedure
    .input(smartCreateChapterSchema)
    .use(isProjectOwner)
    .mutation(async ({ ctx, input }) => {
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

      // Get all user's ready references for prompt context and auto-detection
      const allUserRefs = await dbRead.comicReference.findMany({
        where: { userId: ctx.user!.id, status: ComicReferenceStatus.Ready },
        select: { id: true, name: true },
      });
      const allReferenceNames = allUserRefs.map((r) => r.name);

      // Resolve referenceIds: explicit > all ready refs as fallback
      const allowedRefIds = new Set(allUserRefs.map((r) => r.id));
      if (input.referenceIds && input.referenceIds.some((id) => !allowedRefIds.has(id))) {
        throw throwAuthorizationError();
      }
      const baseReferenceIds =
        input.referenceIds && input.referenceIds.length > 0
          ? input.referenceIds
          : allUserRefs.map((r) => r.id);

      // Get ref images from all resolved references
      let primaryReferenceName = '';
      const combinedRefImages: { url: string; width: number; height: number }[] = [];
      for (const refId of baseReferenceIds) {
        const { referenceName, refImages: imgs } = await getReferenceImages(refId);
        if (!primaryReferenceName && referenceName) primaryReferenceName = referenceName;
        combinedRefImages.push(...imgs);
      }
      if (combinedRefImages.length === 0) {
        throw throwBadRequestError('References have no reference images');
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

        // Per-panel @mention auto-detection: only track explicitly mentioned refs
        const { mentionedIds } = resolveReferenceMentions({
          prompt: panelInput.prompt,
          references: allUserRefs,
        });

        const panel = await createSinglePanel({
          projectId: input.projectId,
          chapterPosition: chapter.position,
          referenceIds: mentionedIds,
          prompt: panelInput.prompt,
          enhance: input.enhance,
          position: i,
          contextPanel,
          allReferenceNames,
          primaryReferenceName,
          refImages: combinedRefImages,
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
        });

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

      // Determine which references provide images for generation.
      // Default to only the mentioned references (from the prompt), not all refs.
      const allowedRefIds = new Set(allUserRefs.map((r) => r.id));
      let generationReferenceIds: number[];
      if (input.referenceIds && input.referenceIds.length > 0) {
        if (input.referenceIds.some((id) => !allowedRefIds.has(id))) {
          throw throwAuthorizationError();
        }
        generationReferenceIds = input.referenceIds;
      } else {
        generationReferenceIds =
          mentionedReferenceIds.length > 0
            ? mentionedReferenceIds
            : allUserRefs.map((r) => r.id);
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

      // Build images array: source image first, then reference images, then optional previous panel image
      const sourceEdgeUrl = getEdgeUrl(input.sourceImageUrl, { original: true });
      const allImages = [
        {
          url: sourceEdgeUrl,
          width: input.sourceImageWidth,
          height: input.sourceImageHeight,
        },
        ...combinedRefImages,
      ];
      if (input.includePreviousImage && contextPanel?.imageUrl) {
        const prevEdgeUrl = getEdgeUrl(contextPanel.imageUrl, { original: true });
        allImages.push({ url: prevEdgeUrl, width: panelWidth, height: panelHeight });
      }

      const token = await getOrchestratorToken(ctx.user!.id, ctx);

      // Build prompt — optionally enhance
      const userPrompt = input.prompt?.trim() || '';
      let fullPrompt = userPrompt;
      if (input.enhance && userPrompt) {
        fullPrompt = await enhanceComicPrompt({
          token,
          userPrompt,
          characterName: primaryReferenceName,
          characterNames: allReferenceNames,
          previousPanel: effectiveContext ?? undefined,
        });
      }

      const metadata = {
        sourceImageUrl: input.sourceImageUrl,
        sourceImageWidth: input.sourceImageWidth,
        sourceImageHeight: input.sourceImageHeight,
        referenceImages: combinedRefImages,
        selectedImageIds: input.selectedImageIds ?? null,
        useContext: input.useContext,
        includePreviousImage: input.includePreviousImage,
        enhanceEnabled: input.enhance,
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
          enhancedPrompt: input.enhance && userPrompt ? fullPrompt : null,
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

        const errorMessage = errorDetails.join(' | ');
        console.error('Comics enhancePanel generation failed:', {
          panelId: panel.id,
          error: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
        });

        const updated = await dbWrite.comicPanel.update({
          where: { id: panel.id },
          data: { status: ComicPanelStatus.Failed, errorMessage },
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

      // Get reference images (needed for generated panels)
      let primaryReferenceName = '';
      const combinedRefImages: { url: string; width: number; height: number }[] = [];
      for (const refId of allUserRefs.map((r) => r.id)) {
        const { referenceName, refImages: imgs } = await getReferenceImages(refId);
        if (!primaryReferenceName && referenceName) primaryReferenceName = referenceName;
        combinedRefImages.push(...imgs);
      }

      const batchToken = await getOrchestratorToken(ctx.user!.id, ctx);

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
          // Resolve @mentions from prompt
          const { mentionedIds } = resolveReferenceMentions({
            prompt: panelDef.prompt,
            references: allUserRefs,
          });

          // Build prompt — optionally enhance
          let fullPrompt = panelDef.prompt;
          if (panelDef.enhance) {
            fullPrompt = await enhanceComicPrompt({
              token: batchToken,
              userPrompt: panelDef.prompt,
              characterName: primaryReferenceName,
              characterNames: allReferenceNames,
              previousPanel: contextPanel ?? undefined,
            });
          }

          const sourceEdgeUrl = getEdgeUrl(panelDef.sourceImageUrl, { original: true });
          const allImages = [
            {
              url: sourceEdgeUrl,
              width: panelDef.sourceImageWidth ?? 512,
              height: panelDef.sourceImageHeight ?? 512,
            },
            ...combinedRefImages,
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
            referenceImages: combinedRefImages,
            enhanceEnabled: panelDef.enhance,
            primaryReferenceName,
            allReferenceNames,
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
              enhancedPrompt: panelDef.enhance ? fullPrompt : null,
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
            createdPanels.push(updated);
            contextPanel = {
              id: updated.id,
              prompt: panelDef.prompt,
              enhancedPrompt: updated.enhancedPrompt,
              imageUrl: updated.imageUrl,
            };
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

            const errorMessage = errorDetails.join(' | ');
            console.error('Comics bulkCreatePanels enhance failed:', {
              panelId: panel.id,
              error: errorMessage,
              stack: error instanceof Error ? error.stack : undefined,
            });

            const updated = await dbWrite.comicPanel.update({
              where: { id: panel.id },
              data: { status: ComicPanelStatus.Failed, errorMessage },
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
          if (combinedRefImages.length === 0) {
            throw throwBadRequestError('No references available for generation');
          }

          const { mentionedIds } = resolveReferenceMentions({
            prompt: panelDef.prompt,
            references: allUserRefs,
          });

          const { width: txtPanelW, height: txtPanelH } = getAspectRatioDimensions(
            panelDef.aspectRatio,
            bulkModelConfig
          );
          const panel = await createSinglePanel({
            projectId: input.projectId,
            chapterPosition: input.chapterPosition,
            referenceIds: mentionedIds,
            prompt: panelDef.prompt,
            enhance: panelDef.enhance,
            position,
            contextPanel,
            allReferenceNames,
            primaryReferenceName,
            refImages: combinedRefImages,
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
    .query(async ({ input }) => {
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
            select: {
              id: true,
              content: true,
              createdAt: true,
              user: { select: userWithCosmeticsSelect },
              reactions: { select: { userId: true, reaction: true } },
            },
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
});
