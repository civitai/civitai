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
import { resolveReferenceMentions } from '~/server/services/comics/mention-resolver';
import { rollupNsfwFromPanel } from '~/server/services/comics/nsfw-rollup';
import { ingestImageById } from '~/server/services/image.service';
import { createNotification } from '~/server/services/notification.service';
import { planChapterPanels } from '~/server/services/comics/story-plan';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { NotificationCategory } from '~/server/common/enums';

// Constants
const NANOBANANA_VERSION_ID = 2154472;
const PANEL_WIDTH = 1728;
const PANEL_HEIGHT = 2304;

// Middleware to check project ownership
const isProjectOwner = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { projectId } = input as { projectId?: string };
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

  const { chapterId } = input as { chapterId?: string };
  if (chapterId) {
    const chapter = await dbRead.comicChapter.findUnique({
      where: { id: chapterId },
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
});

const getProjectSchema = z.object({
  id: z.string(),
});

// Reference (character/location/item) creation — always global per user
const createReferenceSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.nativeEnum(ComicReferenceType).default(ComicReferenceType.Character),
  description: z.string().max(2000).optional(),
});

const addReferenceImagesSchema = z.object({
  referenceId: z.string(),
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
  chapterId: z.string(),
  referenceIds: z.array(z.string()).optional(),
  prompt: z.string().min(1).max(2000),
  enhance: z.boolean().default(true),
  useContext: z.boolean().default(true),
  includePreviousImage: z.boolean().default(false),
  position: z.number().int().min(0).optional(),
});

const updatePanelSchema = z.object({
  panelId: z.string(),
  status: z.nativeEnum(ComicPanelStatus).optional(),
  imageUrl: z.string().url().optional(),
  civitaiJobId: z.string().optional(),
  errorMessage: z.string().optional(),
});

const deletePanelSchema = z.object({
  panelId: z.string(),
});

const reorderPanelsSchema = z.object({
  chapterId: z.string(),
  panelIds: z.array(z.string()),
});

// Chapter schemas
const createChapterSchema = z.object({
  projectId: z.string(),
  name: z.string().min(1).max(255).default('New Chapter'),
});

const updateChapterSchema = z.object({
  chapterId: z.string(),
  name: z.string().min(1).max(255),
});

const deleteChapterSchema = z.object({
  chapterId: z.string(),
});

const reorderChaptersSchema = z.object({
  projectId: z.string(),
  chapterIds: z.array(z.string()),
});

const planChapterPanelsSchema = z.object({
  projectId: z.string(),
  storyDescription: z.string().min(1).max(5000),
});

const smartCreateChapterSchema = z.object({
  projectId: z.string(),
  chapterName: z.string().min(1).max(255).default('New Chapter'),
  referenceIds: z.array(z.string()).optional(),
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
  chapterId: z.string(),
  sourceImageUrl: z.string().min(1),
  sourceImageWidth: z.number().int().positive(),
  sourceImageHeight: z.number().int().positive(),
  prompt: z.string().max(2000).optional(),
  enhance: z.boolean().default(true),
  useContext: z.boolean().default(true),
  includePreviousImage: z.boolean().default(false),
  position: z.number().int().min(0).optional(),
});

const updateProjectSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(5000).nullish(),
  coverImageUrl: z.string().max(500).nullish(),
});

const deleteReferenceSchema = z.object({
  referenceId: z.string(),
});

// Shared helper: resolve a reference's images for generation
async function getReferenceImages(referenceId: string) {
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
  chapterId: string;
  referenceIds: string[];
  prompt: string;
  enhance: boolean;
  position: number;
  contextPanel: {
    id: string;
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
    chapterId,
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

  // Build prompt — optionally enhance via LLM
  let fullPrompt: string;
  if (enhance) {
    fullPrompt = await enhanceComicPrompt({
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
      chapterId,
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
    const token = await getOrchestratorToken(userId, ctx);
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
        coverImageUrl: p.coverImageUrl,
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
            id: true,
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
        cursor: z.string().optional(),
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
          coverImageUrl: true,
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
              id: true,
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

      let nextCursor: string | undefined;
      if (projects.length > limit) {
        const nextItem = projects.pop()!;
        nextCursor = nextItem.id;
      }

      const items = projects.map((p) => {
        const readyPanelCount = p.chapters.reduce((sum, ch) => sum + ch._count.panels, 0);
        const chapterCount = p.chapters.length;
        const thumbnailUrl =
          p.coverImageUrl ??
          p.chapters.flatMap((ch) => ch.panels).find((panel) => panel.imageUrl)?.imageUrl ??
          null;

        // Latest 3 published chapters
        const latestChapters = p.chapters.slice(0, 3).map((ch) => ({
          id: ch.id,
          name: ch.name,
          publishedAt: ch.publishedAt,
        }));

        return {
          id: p.id,
          name: p.name,
          description: p.description,
          thumbnailUrl,
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
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const project = await dbRead.comicProject.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          name: true,
          description: true,
          coverImageUrl: true,
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
              id: true,
              name: true,
              position: true,
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
        coverImageUrl: project.coverImageUrl,
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

  createProject: protectedProcedure.input(createProjectSchema).mutation(async ({ ctx, input }) => {
    const project = await dbWrite.comicProject.create({
      data: {
        userId: ctx.user.id,
        name: input.name,
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
    if (input.coverImageUrl !== undefined) data.coverImageUrl = input.coverImageUrl;

    const updated = await dbWrite.comicProject.update({
      where: { id: input.id },
      data,
    });

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
      where: { id: input.chapterId },
      include: { project: { select: { userId: true } } },
    });
    if (!chapter || chapter.project.userId !== ctx.user.id) {
      throw throwAuthorizationError();
    }

    const updated = await dbWrite.comicChapter.update({
      where: { id: input.chapterId },
      data: { name: input.name },
    });

    return updated;
  }),

  deleteChapter: protectedProcedure.input(deleteChapterSchema).mutation(async ({ ctx, input }) => {
    const chapter = await dbRead.comicChapter.findUnique({
      where: { id: input.chapterId },
      include: { project: { select: { userId: true } } },
    });
    if (!chapter || chapter.project.userId !== ctx.user.id) {
      throw throwAuthorizationError();
    }

    await dbWrite.comicChapter.delete({
      where: { id: input.chapterId },
    });

    return { success: true };
  }),

  reorderChapters: protectedProcedure
    .input(reorderChaptersSchema)
    .use(isProjectOwner)
    .mutation(async ({ input }) => {
      const chapters = await dbRead.comicChapter.findMany({
        where: { projectId: input.projectId },
        select: { id: true },
      });
      const projectChapterIds = new Set(chapters.map((c) => c.id));
      for (const id of input.chapterIds) {
        if (!projectChapterIds.has(id)) {
          throw throwBadRequestError('Chapter does not belong to this project');
        }
      }

      await dbWrite.$transaction(
        input.chapterIds.map((id, index) =>
          dbWrite.comicChapter.update({
            where: { id },
            data: { position: index },
          })
        )
      );

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
    .input(z.object({ referenceId: z.string() }))
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
        where: { id: input.chapterId },
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
      let mentionedReferenceIds: string[];
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
        id: string;
        position: number;
        prompt: string;
        enhancedPrompt: string | null;
        imageUrl: string | null;
      } | null;

      if (input.position != null) {
        // Get the panel just before the insertion point (position < input.position)
        contextPanel = await dbRead.comicPanel.findFirst({
          where: { chapterId: input.chapterId, position: { lt: input.position } },
          orderBy: { position: 'desc' },
          select: { id: true, position: true, prompt: true, enhancedPrompt: true, imageUrl: true },
        });

        // Shift panels at or after the insertion point
        await dbWrite.comicPanel.updateMany({
          where: { chapterId: input.chapterId, position: { gte: input.position } },
          data: { position: { increment: 1 } },
        });
        nextPosition = input.position;
      } else {
        // Appending: use the last panel for context (use dbWrite to reduce race window)
        contextPanel = await dbWrite.comicPanel.findFirst({
          where: { chapterId: input.chapterId },
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

      // Build prompt — optionally enhance via LLM
      let fullPrompt: string;
      if (input.enhance) {
        fullPrompt = await enhanceComicPrompt({
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
          chapterId: input.chapterId,
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
        const token = await getOrchestratorToken(ctx.user!.id, ctx);
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

    return { success: true };
  }),

  reorderPanels: protectedProcedure
    .input(reorderPanelsSchema)
    .use(isChapterOwner)
    .mutation(async ({ input }) => {
      // Verify all panels belong to this chapter
      const panels = await dbRead.comicPanel.findMany({
        where: { chapterId: input.chapterId },
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
    .input(z.object({ panelId: z.string() }))
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
    .input(z.object({ panelId: z.string() }))
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

          // Trigger image ingestion + NSFW rollup asynchronously
          ingestImageById({ id: image.id }).catch((e) =>
            console.error(`Failed to ingest comic panel image ${image.id}:`, e)
          );
          rollupNsfwFromPanel(panel.id).catch((e) =>
            console.error(`Failed to rollup NSFW for panel ${panel.id}:`, e)
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
      // Get all user's reference names for story planning
      const allUserRefs = await dbRead.comicReference.findMany({
        where: { userId: ctx.user!.id, status: ComicReferenceStatus.Ready },
        select: { name: true },
      });

      return planChapterPanels({
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
        id: string;
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
          chapterId: chapter.id,
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
    .input(z.object({ chapterId: z.string() }))
    .use(isChapterOwner)
    .mutation(async ({ ctx, input }) => {
      const chapter = await dbRead.comicChapter.findUnique({
        where: { id: input.chapterId },
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
        where: { id: input.chapterId },
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
            key: `new-comic-chapter:${input.chapterId}`,
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

      return updated;
    }),

  unpublishChapter: protectedProcedure
    .input(z.object({ chapterId: z.string() }))
    .use(isChapterOwner)
    .mutation(async ({ ctx, input }) => {
      const chapter = await dbRead.comicChapter.findUnique({
        where: { id: input.chapterId },
        include: { project: { select: { userId: true } } },
      });
      if (!chapter || chapter.project.userId !== ctx.user!.id) {
        throw throwAuthorizationError();
      }

      const updated = await dbWrite.comicChapter.update({
        where: { id: input.chapterId },
        data: { status: ComicChapterStatus.Draft },
      });

      return updated;
    }),

  // ──── Phase 3: Comic Engagement (Follow/Hide) ────

  toggleComicEngagement: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        type: z.nativeEnum(ComicEngagementType),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const engagement = await dbRead.comicProjectEngagement.findUnique({
        where: { userId_projectId: { userId: ctx.user.id, projectId: input.projectId } },
      });

      if (engagement) {
        if (engagement.type === input.type) {
          // Same type — toggle off
          await dbWrite.comicProjectEngagement.delete({
            where: { userId_projectId: { userId: ctx.user.id, projectId: input.projectId } },
          });
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
    .input(z.object({ projectId: z.string() }))
    .query(async ({ ctx, input }) => {
      const engagement = await dbRead.comicProjectEngagement.findUnique({
        where: { userId_projectId: { userId: ctx.user.id, projectId: input.projectId } },
      });
      return engagement?.type ?? null;
    }),

  // ──── Phase 3: Chapter Read Tracking ────

  markChapterRead: protectedProcedure
    .input(z.object({ chapterId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await dbWrite.comicChapterRead.upsert({
        where: { userId_chapterId: { userId: ctx.user.id, chapterId: input.chapterId } },
        create: { userId: ctx.user.id, chapterId: input.chapterId },
        update: { readAt: new Date() },
      });
      return { success: true };
    }),

  getChapterReadStatus: protectedProcedure
    .input(z.object({ chapterIds: z.array(z.string()) }))
    .query(async ({ ctx, input }) => {
      const reads = await dbRead.comicChapterRead.findMany({
        where: { userId: ctx.user.id, chapterId: { in: input.chapterIds } },
        select: { chapterId: true, readAt: true },
      });
      const readMap: Record<string, Date> = {};
      for (const r of reads) readMap[r.chapterId] = r.readAt;
      return readMap;
    }),

  // ──── Enhance Panel: create from existing image, optionally with img2img ────

  enhancePanel: protectedProcedure
    .input(enhancePanelSchema)
    .use(isChapterOwner)
    .mutation(async ({ ctx, input }) => {
      const chapter = await dbRead.comicChapter.findUnique({
        where: { id: input.chapterId },
        include: { project: { select: { id: true, userId: true } } },
      });
      if (!chapter || chapter.project.userId !== ctx.user!.id) {
        throw throwAuthorizationError();
      }

      // Get next position
      let nextPosition: number;
      if (input.position != null) {
        await dbWrite.comicPanel.updateMany({
          where: { chapterId: input.chapterId, position: { gte: input.position } },
          data: { position: { increment: 1 } },
        });
        nextPosition = input.position;
      } else {
        const lastPanel = await dbWrite.comicPanel.findFirst({
          where: { chapterId: input.chapterId },
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
            chapterId: input.chapterId,
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

        ingestImageById({ id: image.id }).catch((e) =>
          console.error(`Failed to ingest enhanced panel image ${image.id}:`, e)
        );
        rollupNsfwFromPanel(panel.id).catch((e) =>
          console.error(`Failed to rollup NSFW for panel ${panel.id}:`, e)
        );

        return panel;
      }

      // With prompt → img2img generation
      // Fetch previous panel for context if requested
      let contextPanel: {
        id: string;
        prompt: string;
        enhancedPrompt: string | null;
        imageUrl: string | null;
      } | null = null;
      if (input.position != null) {
        contextPanel = await dbRead.comicPanel.findFirst({
          where: { chapterId: input.chapterId, position: { lt: input.position } },
          orderBy: { position: 'desc' },
          select: { id: true, prompt: true, enhancedPrompt: true, imageUrl: true },
        });
      } else {
        contextPanel = await dbRead.comicPanel.findFirst({
          where: { chapterId: input.chapterId },
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

      // Build prompt — optionally enhance
      let fullPrompt = input.prompt;
      if (input.enhance) {
        fullPrompt = await enhanceComicPrompt({
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
          chapterId: input.chapterId,
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
        const token = await getOrchestratorToken(ctx.user!.id, ctx);
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

  // ──── Phase 2: Create panel from existing Image (manual mode) ────

  createPanelFromImage: protectedProcedure
    .input(
      z.object({
        chapterId: z.string(),
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
          where: { chapterId: input.chapterId, position: { gte: input.position } },
          data: { position: { increment: 1 } },
        });
        nextPosition = input.position;
      } else {
        const lastPanel = await dbWrite.comicPanel.findFirst({
          where: { chapterId: input.chapterId },
          orderBy: { position: 'desc' },
          select: { position: true },
        });
        nextPosition = (lastPanel?.position ?? -1) + 1;
      }

      const panel = await dbWrite.comicPanel.create({
        data: {
          chapterId: input.chapterId,
          imageId: input.imageId,
          imageUrl: image.url,
          prompt: input.prompt,
          position: nextPosition,
          status: ComicPanelStatus.Ready,
        },
      });

      // Trigger NSFW rollup
      rollupNsfwFromPanel(panel.id).catch((e) =>
        console.error(`Failed to rollup NSFW for panel ${panel.id}:`, e)
      );

      return panel;
    }),

  // ──── Phase 4: Reference aliases ────

  getReference: protectedProcedure
    .input(z.object({ referenceId: z.string() }))
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
    .input(z.object({ chapterId: z.string() }))
    .query(async ({ input }) => {
      const thread = await dbRead.thread.findUnique({
        where: { comicChapterId: input.chapterId },
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
        chapterId: z.string(),
        content: z.string().min(1).max(10000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Find or create thread for this chapter (upsert avoids race condition)
      const thread = await dbWrite.thread.upsert({
        where: { comicChapterId: input.chapterId },
        create: { comicChapterId: input.chapterId },
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
