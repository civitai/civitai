import { z } from 'zod';
import type { SessionUser } from 'next-auth';
import { router, protectedProcedure, publicProcedure, middleware } from '~/server/trpc';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import {
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
import { ingestImageById } from '~/server/services/image.service';
import { createNotification } from '~/server/services/notification.service';
import { planChapterPanels } from '~/server/services/comics/story-plan';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { NotificationCategory, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { comicsSearchIndex } from '~/server/search-index';

// Constants
const NANOBANANA_VERSION_ID = 2154472;
const PANEL_WIDTH = 1728;
const PANEL_HEIGHT = 2304;

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
  name: z.string().min(1).max(255),
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

const createPanelSchema = z.object({
  projectId: z.number().int(),
  chapterPosition: z.number().int().min(0),
  referenceIds: z.array(z.number().int()).optional(),
  prompt: z.string().min(1).max(2000),
  enhance: z.boolean().default(true),
  useContext: z.boolean().default(true),
  includePreviousImage: z.boolean().default(false),
  position: z.number().int().min(0).optional(),
});

const updatePanelSchema = z.object({
  panelId: z.number().int(),
  status: z.nativeEnum(ComicPanelStatus).optional(),
  imageUrl: z.string().url().optional(),
  civitaiJobId: z.string().optional(),
  errorMessage: z.string().optional(),
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
});

const enhancePanelSchema = z.object({
  projectId: z.number().int(),
  chapterPosition: z.number().int().min(0),
  sourceImageUrl: z.string().min(1),
  sourceImageWidth: z.number().int().positive(),
  sourceImageHeight: z.number().int().positive(),
  prompt: z.string().max(2000).optional(),
  enhance: z.boolean().default(true),
  useContext: z.boolean().default(true),
  includePreviousImage: z.boolean().default(false),
  position: z.number().int().min(0).optional(),
});

const bulkCreatePanelsSchema = z.object({
  projectId: z.number().int(),
  chapterPosition: z.number().int().min(0),
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
  coverImageId: z.number().int().nullish(),
  coverUrl: z.string().nullish(),
  heroImageId: z.number().int().nullish(),
  heroUrl: z.string().nullish(),
  heroImagePosition: z.number().int().min(0).max(100).optional(),
});

const deleteReferenceSchema = z.object({
  referenceId: z.number().int(),
});

// Shared helper: resolve a reference's images for generation
async function getReferenceImages(referenceId: number) {
  const reference = await dbRead.comicReference.findUnique({
    where: { id: referenceId },
    select: {
      name: true,
      images: {
        orderBy: { position: 'asc' },
        include: { image: { select: { url: true, width: true, height: true } } },
      },
    },
  });

  if (!reference) return { referenceName: '', refImages: [] };

  return {
    referenceName: reference.name,
    refImages: reference.images.map((ri) => ({
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
      engine: 'gemini',
      baseModel: 'NanoBanana',
      checkpointVersionId: NANOBANANA_VERSION_ID,
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
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
        engine: 'gemini',
        baseModel: 'NanoBanana' as any,
        width: PANEL_WIDTH,
        height: PANEL_HEIGHT,
        workflow: 'txt2img',
        sampler: 'Euler',
        steps: 25,
        quantity: 1,
        draft: false,
        disablePoi: false,
        priority: 'low',
        sourceImage: null,
        images: refImages,
      },
      resources: [{ id: NANOBANANA_VERSION_ID, strength: 1 }],
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
  getMyProjects: protectedProcedure.query(async ({ ctx }) => {
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

  getProject: protectedProcedure.input(getProjectSchema).query(async ({ ctx, input }) => {
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
              },
            },
          },
        },
      },
    });

    if (!project || project.userId !== ctx.user.id) {
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

  getProjectForReader: protectedProcedure.input(getProjectSchema).query(async ({ ctx, input }) => {
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

    if (!project || project.userId !== ctx.user.id) {
      throw throwAuthorizationError();
    }

    return {
      id: project.id,
      name: project.name,
      chapters: project.chapters,
    };
  }),

  // Public queries — no auth required
  getPublicProjects: publicProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(50).default(20),
        cursor: z.number().int().optional(),
        genre: z.nativeEnum(ComicGenre).optional(),
        period: z.enum(['Day', 'Week', 'Month', 'Year', 'AllTime']).optional(),
        sort: z.enum(['Newest', 'MostFollowed', 'MostChapters']).default('Newest'),
        followed: z.boolean().optional(),
        userId: z.number().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const { limit, cursor, genre, period, sort, followed, userId } = input;

      // Build where clause
      const where: any = {
        status: ComicProjectStatus.Active,
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

  getPublicProjectForReader: publicProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ input }) => {
      const project = await dbRead.comicProject.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          name: true,
          description: true,
          coverImage: { select: { id: true, url: true, nsfwLevel: true } },
          heroImage: { select: { id: true, url: true, nsfwLevel: true } },
          heroImagePosition: true,
          genre: true,
          nsfwLevel: true,
          status: true,
          user: {
            select: userWithCosmeticsSelect,
          },
          chapters: {
            where: { status: ComicChapterStatus.Published },
            orderBy: { position: 'asc' },
            select: {
              projectId: true,
              position: true,
              name: true,
              nsfwLevel: true,
              publishedAt: true,
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

      // Filter out chapters with no ready panels
      const chapters = project.chapters.filter((ch) => ch.panels.length > 0);

      if (chapters.length === 0) {
        throw throwNotFoundError('Comic not found');
      }

      return {
        id: project.id,
        name: project.name,
        description: project.description,
        nsfwLevel: project.nsfwLevel,
        coverImage: project.coverImage,
        heroImage: project.heroImage,
        heroImagePosition: project.heroImagePosition,
        user: project.user,
        chapters,
      };
    }),

  // Dynamic pricing — whatIf cost estimate for panel generation
  getPanelCostEstimate: protectedProcedure.query(async ({ ctx }) => {
    try {
      const token = await getOrchestratorToken(ctx.user.id, ctx);

      const step = await createImageGenStep({
        params: {
          prompt: '',
          negativePrompt: '',
          engine: 'gemini',
          baseModel: 'NanoBanana' as any,
          width: PANEL_WIDTH,
          height: PANEL_HEIGHT,
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
        resources: [{ id: NANOBANANA_VERSION_ID, strength: 1 }],
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

  getPromptEnhanceCostEstimate: protectedProcedure.query(async ({ ctx }) => {
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

  getPlanChapterCostEstimate: protectedProcedure.query(async ({ ctx }) => {
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

  createProject: protectedProcedure.input(createProjectSchema).mutation(async ({ ctx, input }) => {
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
      const image = await dbWrite.image.create({
        data: {
          url: input.coverUrl,
          userId: ctx.user.id,
          width: 0,
          height: 0,
          ingestion: 'Pending',
        },
      });
      await dbWrite.comicProject.update({
        where: { id: project.id },
        data: { coverImageId: image.id },
      });
      ingestImageById({ id: image.id }).catch((e) =>
        console.error(`Failed to ingest cover image ${image.id}:`, e)
      );
    }

    // Handle hero image
    if (input.heroUrl) {
      const image = await dbWrite.image.create({
        data: {
          url: input.heroUrl,
          userId: ctx.user.id,
          width: 0,
          height: 0,
          ingestion: 'Pending',
        },
      });
      await dbWrite.comicProject.update({
        where: { id: project.id },
        data: { heroImageId: image.id },
      });
      ingestImageById({ id: image.id }).catch((e) =>
        console.error(`Failed to ingest hero image ${image.id}:`, e)
      );
    }

    await comicsSearchIndex.queueUpdate([
      { id: project.id, action: SearchIndexUpdateQueueAction.Update },
    ]);

    return project;
  }),

  deleteProject: protectedProcedure.input(getProjectSchema).mutation(async ({ ctx, input }) => {
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

  updateProject: protectedProcedure.input(updateProjectSchema).mutation(async ({ ctx, input }) => {
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
    if (input.heroImagePosition !== undefined) data.heroImagePosition = input.heroImagePosition;

    // Cover image: accept either an existing Image ID or a CF URL (creates Image record)
    if (input.coverImageId !== undefined) {
      data.coverImageId = input.coverImageId;
    } else if (input.coverUrl !== undefined) {
      if (input.coverUrl) {
        const image = await dbWrite.image.create({
          data: {
            url: input.coverUrl,
            userId: ctx.user.id,
            width: 0,
            height: 0,
            ingestion: 'Pending',
          },
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
        const image = await dbWrite.image.create({
          data: {
            url: input.heroUrl,
            userId: ctx.user.id,
            width: 0,
            height: 0,
            ingestion: 'Pending',
          },
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

    // Trigger ingestion for new images
    if (data.coverImageId) {
      ingestImageById({ id: data.coverImageId }).catch((e) =>
        console.error(`Failed to ingest cover image ${data.coverImageId}:`, e)
      );
    }
    if (data.heroImageId) {
      ingestImageById({ id: data.heroImageId }).catch((e) =>
        console.error(`Failed to ingest hero image ${data.heroImageId}:`, e)
      );
    }

    await comicsSearchIndex.queueUpdate([
      { id: input.id, action: SearchIndexUpdateQueueAction.Update },
    ]);

    return updated;
  }),

  // Chapters
  createChapter: protectedProcedure
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

  updateChapter: protectedProcedure.input(updateChapterSchema).mutation(async ({ ctx, input }) => {
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

  deleteChapter: protectedProcedure.input(deleteChapterSchema).mutation(async ({ ctx, input }) => {
    const chapter = await dbRead.comicChapter.findUnique({
      where: {
        projectId_position: { projectId: input.projectId, position: input.chapterPosition },
      },
      include: { project: { select: { userId: true } } },
    });
    if (!chapter || chapter.project.userId !== ctx.user.id) {
      throw throwAuthorizationError();
    }

    await dbWrite.comicChapter.delete({
      where: {
        projectId_position: { projectId: input.projectId, position: input.chapterPosition },
      },
    });

    // Recalculate project NSFW level after chapter removal
    updateComicProjectNsfwLevels([input.projectId]).catch((e) =>
      console.error(`Failed to update project NSFW after chapter delete:`, e)
    );

    return { success: true };
  }),

  reorderChapters: protectedProcedure
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

  createReference: protectedProcedure
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
  addReferenceImages: protectedProcedure
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
        const image = await dbWrite.image.create({
          data: {
            url: img.url,
            userId: ctx.user!.id,
            width: img.width,
            height: img.height,
            ingestion: 'Pending',
          },
        });

        await dbWrite.comicReferenceImage.create({
          data: {
            referenceId: input.referenceId,
            imageId: image.id,
            position: nextPosition++,
          },
        });

        // Trigger ingestion asynchronously
        ingestImageById({ id: image.id }).catch((e) =>
          console.error(`Failed to ingest reference image ${image.id}:`, e)
        );
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
  pollReferenceStatus: protectedProcedure
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

  // Panels — NanoBanana generation via createImageGen
  createPanel: protectedProcedure
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
            select: { id: true, userId: true },
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

      // Resolve which references the user explicitly mentioned (for panel association)
      const allowedRefIds = new Set(allUserRefs.map((r) => r.id));
      let mentionedReferenceIds: number[];
      if (input.referenceIds && input.referenceIds.length > 0) {
        // Validate all provided IDs belong to the current user
        if (input.referenceIds.some((id) => !allowedRefIds.has(id))) {
          throw throwAuthorizationError();
        }
        mentionedReferenceIds = input.referenceIds;
      } else {
        const { mentionedIds } = resolveReferenceMentions({
          prompt: input.prompt,
          references: allUserRefs,
        });
        mentionedReferenceIds = mentionedIds;
      }

      // All references are used for generation images; only mentioned ones are tracked on the panel
      const generationReferenceIds = allUserRefs.length > 0 ? allUserRefs.map((r) => r.id) : [];

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

      // Get reference images for generation — all user references
      let primaryReferenceName = '';
      const combinedRefImages: { url: string; width: number; height: number }[] = [];

      for (const refId of generationReferenceIds) {
        const { referenceName, refImages: imgs } = await getReferenceImages(refId);
        if (!primaryReferenceName && referenceName) primaryReferenceName = referenceName;
        combinedRefImages.push(...imgs);
      }

      if (combinedRefImages.length === 0) {
        throw throwBadRequestError('References have no reference images');
      }

      // Conditionally use previous panel context for prompt enhancement
      const effectiveContext = input.useContext ? contextPanel : null;

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
        allImages.push({ url: prevEdgeUrl, width: PANEL_WIDTH, height: PANEL_HEIGHT });
      }

      // Build metadata for debugging
      const metadata = {
        previousPanelId: effectiveContext?.id ?? null,
        previousPanelPrompt: effectiveContext
          ? effectiveContext.enhancedPrompt ?? effectiveContext.prompt
          : null,
        previousPanelImageUrl: contextPanel?.imageUrl ?? null,
        referenceImages: combinedRefImages,
        useContext: input.useContext,
        includePreviousImage: input.includePreviousImage,
        enhanceEnabled: input.enhance,
        primaryReferenceName,
        allReferenceNames,
        generationParams: {
          engine: 'gemini',
          baseModel: 'NanoBanana',
          checkpointVersionId: NANOBANANA_VERSION_ID,
          width: PANEL_WIDTH,
          height: PANEL_HEIGHT,
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

      // Submit NanoBanana generation workflow
      try {
        const result = await createImageGen({
          params: {
            prompt: fullPrompt,
            negativePrompt: '',
            engine: 'gemini',
            baseModel: 'NanoBanana' as any,
            width: PANEL_WIDTH,
            height: PANEL_HEIGHT,
            workflow: 'txt2img',
            sampler: 'Euler',
            steps: 25,
            quantity: 1,
            draft: false,
            disablePoi: false,
            priority: 'low',
            sourceImage: null,
            images: allImages,
          },
          resources: [{ id: NANOBANANA_VERSION_ID, strength: 1 }],
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

  updatePanel: protectedProcedure.input(updatePanelSchema).mutation(async ({ ctx, input }) => {
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

  deletePanel: protectedProcedure.input(deletePanelSchema).mutation(async ({ ctx, input }) => {
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

  reorderPanels: protectedProcedure
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
  getPanelDebugInfo: protectedProcedure
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
        generation: {
          engine: 'gemini',
          baseModel: 'NanoBanana',
          checkpointVersionId: NANOBANANA_VERSION_ID,
          dimensions: { width: PANEL_WIDTH, height: PANEL_HEIGHT },
        },
        workflow: workflowInfo,
      };
    }),

  // Poll panel generation status
  pollPanelStatus: protectedProcedure
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

        // Extract image URL from first step output if present.
        // Images can appear before the workflow status transitions to 'succeeded'
        const steps = workflow.steps ?? [];
        const firstStep = steps[0] as any;
        const imageUrl =
          firstStep?.output?.images?.[0]?.url ?? firstStep?.output?.blobs?.[0]?.url ?? null;

        if (imageUrl) {
          // Create Image record for content moderation pipeline
          const image = await dbWrite.image.create({
            data: {
              url: imageUrl,
              userId: ctx.user!.id,
              width: PANEL_WIDTH,
              height: PANEL_HEIGHT,
              meta: { prompt: panel.prompt },
              ingestion: 'Pending',
            },
          });

          const updated = await dbWrite.comicPanel.update({
            where: { id: panel.id },
            data: {
              status: ComicPanelStatus.Ready,
              imageUrl,
              imageId: image.id,
            },
          });

          // Trigger image ingestion — scan callback handles NSFW level rollup
          ingestImageById({ id: image.id }).catch((e) =>
            console.error(`Failed to ingest comic panel image ${image.id}:`, e)
          );

          return { id: updated.id, status: updated.status, imageUrl: updated.imageUrl };
        }

        // No images yet — check terminal statuses
        if (workflow.status === 'succeeded') {
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
              errorMessage: `Generation ${workflow.status}`,
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
  planChapterPanels: protectedProcedure
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
  smartCreateChapter: protectedProcedure
    .input(smartCreateChapterSchema)
    .use(isProjectOwner)
    .mutation(async ({ ctx, input }) => {
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

  publishChapter: protectedProcedure
    .input(z.object({ projectId: z.number().int(), chapterPosition: z.number().int().min(0) }))
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

      const isFirstPublish = !chapter.publishedAt;
      const updated = await dbWrite.comicChapter.update({
        where: {
          projectId_position: { projectId: input.projectId, position: input.chapterPosition },
        },
        data: {
          status: ComicChapterStatus.Published,
          ...(isFirstPublish ? { publishedAt: new Date() } : {}),
        },
      });

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

  unpublishChapter: protectedProcedure
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

      const updated = await dbWrite.comicChapter.update({
        where: {
          projectId_position: { projectId: input.projectId, position: input.chapterPosition },
        },
        data: { status: ComicChapterStatus.Draft },
      });

      // Update search index — unpublishing may affect discoverability
      await comicsSearchIndex.queueUpdate([
        { id: input.projectId, action: SearchIndexUpdateQueueAction.Update },
      ]);

      return updated;
    }),

  // ──── Phase 3: Comic Engagement (Follow/Hide) ────

  toggleComicEngagement: protectedProcedure
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

  getComicEngagement: protectedProcedure
    .input(z.object({ projectId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const engagement = await dbRead.comicProjectEngagement.findUnique({
        where: { userId_projectId: { userId: ctx.user.id, projectId: input.projectId } },
      });
      if (!engagement || engagement.type === ComicEngagementType.None) return null;
      return engagement.type;
    }),

  // ──── Phase 3: Chapter Read Tracking (via engagement readChapters) ────

  markChapterRead: protectedProcedure
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

  getChapterReadStatus: protectedProcedure
    .input(z.object({ projectId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const engagement = await dbRead.comicProjectEngagement.findUnique({
        where: { userId_projectId: { userId: ctx.user.id, projectId: input.projectId } },
        select: { readChapters: true },
      });
      return engagement?.readChapters ?? [];
    }),

  markChapterUnread: protectedProcedure
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

  enhancePanel: protectedProcedure
    .input(enhancePanelSchema)
    .use(isChapterOwner)
    .mutation(async ({ ctx, input }) => {
      const chapter = await dbRead.comicChapter.findUnique({
        where: {
          projectId_position: { projectId: input.projectId, position: input.chapterPosition },
        },
        include: { project: { select: { id: true, userId: true } } },
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

      // No prompt → create panel directly from image (free)
      if (!input.prompt || !input.prompt.trim()) {
        const image = await dbWrite.image.create({
          data: {
            url: input.sourceImageUrl,
            userId: ctx.user!.id,
            width: input.sourceImageWidth,
            height: input.sourceImageHeight,
            ingestion: 'Pending',
          },
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

        // Trigger image ingestion — scan callback handles NSFW level rollup
        ingestImageById({ id: image.id }).catch((e) =>
          console.error(`Failed to ingest enhanced panel image ${image.id}:`, e)
        );

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

      const allUserRefs = await dbRead.comicReference.findMany({
        where: { userId: ctx.user!.id, status: ComicReferenceStatus.Ready },
        select: { id: true, name: true },
      });
      const allReferenceNames = allUserRefs.map((r) => r.name);

      // Resolve @mentions from prompt (for panel association only)
      const { mentionedIds } = resolveReferenceMentions({
        prompt: input.prompt,
        references: allUserRefs,
      });
      const mentionedReferenceIds = mentionedIds;

      // Gather reference images from all user refs
      let primaryReferenceName = '';
      const combinedRefImages: { url: string; width: number; height: number }[] = [];
      for (const refId of allUserRefs.map((r) => r.id)) {
        const { referenceName, refImages: imgs } = await getReferenceImages(refId);
        if (!primaryReferenceName && referenceName) primaryReferenceName = referenceName;
        combinedRefImages.push(...imgs);
      }

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
        allImages.push({ url: prevEdgeUrl, width: PANEL_WIDTH, height: PANEL_HEIGHT });
      }

      const token = await getOrchestratorToken(ctx.user!.id, ctx);

      // Build prompt — optionally enhance
      let fullPrompt = input.prompt;
      if (input.enhance) {
        fullPrompt = await enhanceComicPrompt({
          token,
          userPrompt: input.prompt,
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
        useContext: input.useContext,
        includePreviousImage: input.includePreviousImage,
        enhanceEnabled: input.enhance,
        primaryReferenceName,
        allReferenceNames,
        generationParams: {
          engine: 'gemini',
          baseModel: 'NanoBanana',
          checkpointVersionId: NANOBANANA_VERSION_ID,
          width: PANEL_WIDTH,
          height: PANEL_HEIGHT,
          prompt: fullPrompt,
          negativePrompt: '',
        },
      };

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

      if (mentionedReferenceIds.length > 0) {
        await dbWrite.comicPanelReference.createMany({
          data: mentionedReferenceIds.map((rid) => ({ panelId: panel.id, referenceId: rid })),
          skipDuplicates: true,
        });
      }

      try {
        const result = await createImageGen({
          params: {
            prompt: fullPrompt,
            negativePrompt: '',
            engine: 'gemini',
            baseModel: 'NanoBanana' as any,
            width: PANEL_WIDTH,
            height: PANEL_HEIGHT,
            workflow: 'txt2img',
            sampler: 'Euler',
            steps: 25,
            quantity: 1,
            draft: false,
            disablePoi: false,
            priority: 'low',
            sourceImage: null,
            images: allImages,
          },
          resources: [{ id: NANOBANANA_VERSION_ID, strength: 1 }],
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

  bulkCreatePanels: protectedProcedure
    .input(bulkCreatePanelsSchema)
    .use(isChapterOwner)
    .mutation(async ({ ctx, input }) => {
      // Verify chapter ownership
      const chapter = await dbRead.comicChapter.findUnique({
        where: {
          projectId_position: { projectId: input.projectId, position: input.chapterPosition },
        },
        include: { project: { select: { id: true, userId: true } } },
      });
      if (!chapter || chapter.project.userId !== ctx.user!.id) {
        throw throwAuthorizationError();
      }

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
          const image = await dbWrite.image.create({
            data: {
              url: panelDef.sourceImageUrl,
              userId: ctx.user!.id,
              width: panelDef.sourceImageWidth ?? 512,
              height: panelDef.sourceImageHeight ?? 512,
              ingestion: 'Pending',
            },
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

          ingestImageById({ id: image.id }).catch((e) =>
            console.error(`Failed to ingest bulk panel image ${image.id}:`, e)
          );

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

          const metadata = {
            sourceImageUrl: panelDef.sourceImageUrl,
            sourceImageWidth: panelDef.sourceImageWidth,
            sourceImageHeight: panelDef.sourceImageHeight,
            referenceImages: combinedRefImages,
            enhanceEnabled: panelDef.enhance,
            primaryReferenceName,
            allReferenceNames,
            generationParams: {
              engine: 'gemini',
              baseModel: 'NanoBanana',
              checkpointVersionId: NANOBANANA_VERSION_ID,
              width: PANEL_WIDTH,
              height: PANEL_HEIGHT,
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
                engine: 'gemini',
                baseModel: 'NanoBanana' as any,
                width: PANEL_WIDTH,
                height: PANEL_HEIGHT,
                workflow: 'txt2img',
                sampler: 'Euler',
                steps: 25,
                quantity: 1,
                draft: false,
                disablePoi: false,
                priority: 'low',
                sourceImage: null,
                images: allImages,
              },
              resources: [{ id: NANOBANANA_VERSION_ID, strength: 1 }],
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

  createPanelFromImage: protectedProcedure
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

  getReference: protectedProcedure
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

  deleteReference: protectedProcedure
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

  getUserReferences: protectedProcedure
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

  getChapterThread: publicProcedure
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
            },
          },
        },
      });

      return thread;
    }),

  createChapterComment: protectedProcedure
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

      return comment;
    }),
});
