import { z } from 'zod';
import type { SessionUser } from 'next-auth';
import {
  router,
  protectedProcedure,
  middleware,
} from '~/server/trpc';
import { dbRead, dbWrite } from '~/server/db/client';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';
import {
  ComicCharacterStatus,
  ComicCharacterSourceType,
  ComicPanelStatus,
  ComicProjectStatus,
} from '~/shared/utils/prisma/enums';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { getGenerationConfig } from '~/server/common/constants';
import { getBaseModelSetType } from '~/shared/constants/generation.constants';
import { createTextToImage } from '~/server/services/orchestrator/textToImage/textToImage';
import { createImageGen } from '~/server/services/orchestrator/imageGen/imageGen';
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import { enhanceComicPrompt } from '~/server/services/comics/prompt-enhance';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';

// Constants
const NANOBANANA_VERSION_ID = 2154472;
const PANEL_WIDTH = 1728;
const PANEL_HEIGHT = 2304;

// View-specific prompts appended after the character's trigger words + name
const REFERENCE_VIEW_SUFFIXES: Record<string, string> = {
  front:
    'solo, front view, facing viewer, looking at viewer, standing, arms at sides, upper body, simple white background, studio lighting, high quality, sharp focus, detailed',
  side:
    'solo, from side, side profile, looking to the side, standing, arms at sides, upper body, simple white background, studio lighting, high quality, sharp focus, detailed',
  back:
    'solo, from behind, back view, looking away, standing, arms at sides, upper body, simple white background, studio lighting, high quality, sharp focus, detailed',
};

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

// Character from uploaded images (triggers training)
const createCharacterFromUploadSchema = z.object({
  projectId: z.string(),
  name: z.string().min(1).max(255),
  referenceImages: z.array(z.string().url()).min(3).max(5),
});

// Character from existing LoRA model
const createCharacterFromModelSchema = z.object({
  projectId: z.string(),
  name: z.string().min(1).max(255),
  modelId: z.number().int().positive(),
  modelVersionId: z.number().int().positive(),
});

const updateCharacterStatusSchema = z.object({
  characterId: z.string(),
  status: z.nativeEnum(ComicCharacterStatus),
  trainingJobId: z.string().optional(),
  trainedModelId: z.number().int().positive().optional(),
  trainedModelVersionId: z.number().int().positive().optional(),
  errorMessage: z.string().optional(),
});

const createPanelSchema = z.object({
  chapterId: z.string(),
  characterId: z.string().optional(),
  prompt: z.string().min(1).max(2000),
  enhance: z.boolean().default(true),
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

const updateProjectSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(5000).nullish(),
  coverImageUrl: z.string().max(500).nullish(),
});

const deleteCharacterSchema = z.object({
  characterId: z.string(),
});

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
      const thumbnailUrl = p.chapters
        .flatMap((ch) => ch.panels)
        .find((panel) => panel.imageUrl)?.imageUrl ?? null;
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

  getProject: protectedProcedure
    .input(getProjectSchema)
    .query(async ({ ctx, input }) => {
      const project = await dbRead.comicProject.findUnique({
        where: { id: input.id },
        include: {
          characters: {
            orderBy: { createdAt: 'asc' },
          },
          chapters: {
            orderBy: { position: 'asc' },
            include: {
              panels: {
                orderBy: { position: 'asc' },
              },
            },
          },
        },
      });

      if (!project || project.userId !== ctx.user.id) {
        throw throwAuthorizationError();
      }

      return project;
    }),

  getProjectForReader: protectedProcedure
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

  createProject: protectedProcedure
    .input(createProjectSchema)
    .mutation(async ({ ctx, input }) => {
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

  deleteProject: protectedProcedure
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

      return { success: true };
    }),

  updateProject: protectedProcedure
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
      // Auto-increment position
      const lastChapter = await dbRead.comicChapter.findFirst({
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

  updateChapter: protectedProcedure
    .input(updateChapterSchema)
    .mutation(async ({ ctx, input }) => {
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

  deleteChapter: protectedProcedure
    .input(deleteChapterSchema)
    .mutation(async ({ ctx, input }) => {
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

  // Characters - Two creation paths

  // Path 1: Create character from uploaded images (triggers training)
  createCharacterFromUpload: protectedProcedure
    .input(createCharacterFromUploadSchema)
    .use(isProjectOwner)
    .mutation(async ({ ctx, input }) => {
      const character = await dbWrite.comicCharacter.create({
        data: {
          projectId: input.projectId,
          userId: ctx.user!.id,
          name: input.name,
          sourceType: ComicCharacterSourceType.Upload,
          referenceImages: input.referenceImages,
          status: ComicCharacterStatus.Pending,
        },
      });

      // TODO: Trigger LoRA training job via training API
      // - Use pre-configured training settings
      // - Update character with trainingJobId
      // - Webhook or polling updates status to Processing -> Ready

      return character;
    }),

  // Path 2: Create character from existing LoRA model (instant — no ref images generated)
  createCharacterFromModel: protectedProcedure
    .input(createCharacterFromModelSchema)
    .use(isProjectOwner)
    .mutation(async ({ ctx, input }) => {
      // Verify the model version exists and is accessible
      const modelVersion = await dbRead.modelVersion.findUnique({
        where: { id: input.modelVersionId },
        select: {
          id: true,
          modelId: true,
          status: true,
          baseModel: true,
          model: {
            select: {
              id: true,
              name: true,
              userId: true,
              status: true,
            },
          },
        },
      });

      if (!modelVersion) {
        throw throwBadRequestError('Model version not found');
      }

      // Check if model is published or owned by user
      const isOwner = modelVersion.model.userId === ctx.user!.id;
      const isPublished = modelVersion.model.status === 'Published';

      if (!isOwner && !isPublished) {
        throw throwAuthorizationError('You do not have access to this model');
      }

      // Set project baseModel from the LoRA's baseModel if not already set
      const baseModelGroup = getBaseModelSetType(modelVersion.baseModel);
      const project = await dbRead.comicProject.findUnique({
        where: { id: input.projectId },
        select: { baseModel: true },
      });
      if (project && !project.baseModel) {
        await dbWrite.comicProject.update({
          where: { id: input.projectId },
          data: { baseModel: baseModelGroup },
        });
      }

      // Create character as Ready immediately (no ref images yet)
      const character = await dbWrite.comicCharacter.create({
        data: {
          projectId: input.projectId,
          userId: ctx.user!.id,
          name: input.name,
          sourceType: ComicCharacterSourceType.ExistingModel,
          modelId: input.modelId,
          modelVersionId: input.modelVersionId,
          status: ComicCharacterStatus.Ready,
        },
      });

      return character;
    }),

  // Generate reference images for an existing character using its LoRA
  generateCharacterReferences: protectedProcedure
    .input(z.object({ characterId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const character = await dbRead.comicCharacter.findUnique({
        where: { id: input.characterId },
        include: { project: { select: { id: true } } },
      });

      if (!character || character.userId !== ctx.user!.id) {
        throw throwAuthorizationError();
      }

      if (character.sourceType !== ComicCharacterSourceType.ExistingModel || !character.modelVersionId) {
        throw throwBadRequestError('Character must be linked to a LoRA model');
      }

      // Fetch model version for trained words and base model
      const modelVersion = await dbRead.modelVersion.findUnique({
        where: { id: character.modelVersionId },
        select: { baseModel: true, trainedWords: true },
      });

      if (!modelVersion) {
        throw throwBadRequestError('Model version not found');
      }

      // Set status to Processing (clears any previous error)
      await dbWrite.comicCharacter.update({
        where: { id: character.id },
        data: { status: ComicCharacterStatus.Processing, errorMessage: null },
      });

      try {
        const baseModelGroup = getBaseModelSetType(modelVersion.baseModel);
        const token = await getOrchestratorToken(ctx.user!.id, ctx);
        const config = getGenerationConfig(baseModelGroup);
        const checkpointVersionId = config.checkpoint.id;
        const trainedWords = (modelVersion.trainedWords ?? []) as string[];
        const triggerPrefix = trainedWords.length > 0 ? `${trainedWords.join(', ')}, ` : '';

        console.log('[Comics] Generating character reference images:', {
          characterId: character.id,
          modelVersionId: character.modelVersionId,
          baseModel: modelVersion.baseModel,
          baseModelGroup,
          checkpointVersionId,
          trainedWords,
          triggerPrefix,
        });

        const workflowIds: Record<string, string> = {};

        for (const [view, viewSuffix] of Object.entries(REFERENCE_VIEW_SUFFIXES)) {
          const fullPrompt = `${triggerPrefix}${character.name}, ${viewSuffix}`;
          console.log(`[Comics] Ref image "${view}" prompt:`, fullPrompt);

          const result = await createTextToImage({
            params: {
              prompt: fullPrompt,
              negativePrompt:
                'blurry, low quality, deformed, bad anatomy, bad hands, extra fingers, missing fingers, text, watermark, signature, jpeg artifacts, ugly, duplicate, morbid, mutilated, poorly drawn face, poorly drawn hands, out of frame',
              baseModel: baseModelGroup as any,
              width: 832,
              height: 1216,
              workflow: 'txt2img',
              sampler: 'Euler',
              steps: 25,
              cfgScale: 7,
              quantity: 1,
              draft: false,
              disablePoi: false,
              priority: 'low',
              sourceImage: null,
              images: null,
            },
            resources: [
              { id: checkpointVersionId, strength: 1 },
              { id: character.modelVersionId, strength: 1 },
            ],
            tags: ['comics', 'character-ref'],
            tips: { creators: 0, civitai: 0 },
            user: ctx.user! as SessionUser,
            token,
            currencies: ['yellow'],
          });

          console.log(`[Comics] Ref image "${view}" workflow submitted:`, result.id);
          workflowIds[view] = result.id;
        }

        const updated = await dbWrite.comicCharacter.update({
          where: { id: character.id },
          data: { referenceImageWorkflowIds: workflowIds },
        });

        return { ...updated, status: ComicCharacterStatus.Processing };
      } catch (error: any) {
        console.error('Failed to generate character reference images:', error);
        await dbWrite.comicCharacter.update({
          where: { id: character.id },
          data: {
            status: ComicCharacterStatus.Failed,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          },
        });
        return {
          ...character,
          status: ComicCharacterStatus.Failed,
          errorMessage: error instanceof Error ? error.message : String(error),
        };
      }
    }),

  // Upload custom reference images for a character
  uploadCharacterReferences: protectedProcedure
    .input(z.object({
      characterId: z.string(),
      referenceImages: z.array(z.object({
        url: z.string().min(1),
        width: z.number(),
        height: z.number(),
      })).min(1).max(5),
    }))
    .mutation(async ({ ctx, input }) => {
      const character = await dbRead.comicCharacter.findUnique({
        where: { id: input.characterId },
      });

      if (!character || character.userId !== ctx.user!.id) {
        throw throwAuthorizationError();
      }

      const updated = await dbWrite.comicCharacter.update({
        where: { id: character.id },
        data: {
          generatedReferenceImages: input.referenceImages.map((img) => ({
            url: img.url,
            width: img.width,
            height: img.height,
            view: 'uploaded',
          })),
          referenceImageWorkflowIds: null,
          status: ComicCharacterStatus.Ready,
          errorMessage: null,
        },
      });

      return updated;
    }),

  // Poll character reference image generation status
  pollCharacterStatus: protectedProcedure
    .input(z.object({ characterId: z.string() }))
    .query(async ({ ctx, input }) => {
      const character = await dbRead.comicCharacter.findUnique({
        where: { id: input.characterId },
      });

      if (!character || character.userId !== ctx.user.id) {
        throw throwAuthorizationError();
      }

      // Only poll if character is actively processing
      if (
        character.status === ComicCharacterStatus.Ready ||
        character.status === ComicCharacterStatus.Failed
      ) {
        return {
          id: character.id,
          status: character.status,
          generatedReferenceImages: character.generatedReferenceImages,
        };
      }

      const workflowIds = character.referenceImageWorkflowIds as Record<string, string> | null;
      if (!workflowIds || Object.keys(workflowIds).length === 0) {
        return {
          id: character.id,
          status: character.status,
          generatedReferenceImages: character.generatedReferenceImages,
        };
      }

      try {
        const token = await getOrchestratorToken(ctx.user.id, ctx);
        const results: { view: string; url: string; width: number; height: number }[] = [];
        let allComplete = true;
        let anyFailed = false;

        for (const [view, workflowId] of Object.entries(workflowIds)) {
          const workflow = await getWorkflow({
            token,
            path: { workflowId },
          });

          const steps = workflow.steps ?? [];
          const firstStep = steps[0] as any;
          const imageUrl =
            firstStep?.output?.images?.[0]?.url ??
            firstStep?.output?.blobs?.[0]?.url ??
            null;

          if (imageUrl) {
            results.push({
              view,
              url: imageUrl,
              width: 832,
              height: 1216,
            });
          } else if (workflow.status === 'failed' || workflow.status === 'canceled') {
            anyFailed = true;
          } else {
            allComplete = false;
          }
        }

        if (anyFailed) {
          const updated = await dbWrite.comicCharacter.update({
            where: { id: character.id },
            data: {
              status: ComicCharacterStatus.Failed,
              errorMessage: 'Reference image generation failed',
              generatedReferenceImages: results.length > 0 ? results : undefined,
            },
          });
          return {
            id: updated.id,
            status: updated.status,
            generatedReferenceImages: updated.generatedReferenceImages,
          };
        }

        if (allComplete && results.length === Object.keys(workflowIds).length) {
          const updated = await dbWrite.comicCharacter.update({
            where: { id: character.id },
            data: {
              status: ComicCharacterStatus.Ready,
              generatedReferenceImages: results,
            },
          });
          return {
            id: updated.id,
            status: updated.status,
            generatedReferenceImages: updated.generatedReferenceImages,
          };
        }

        // Still processing
        return {
          id: character.id,
          status: character.status,
          generatedReferenceImages: character.generatedReferenceImages,
        };
      } catch (error) {
        console.error('Failed to poll character workflows:', error);
        return {
          id: character.id,
          status: character.status,
          generatedReferenceImages: character.generatedReferenceImages,
        };
      }
    }),

  // Legacy endpoint - routes to upload flow (for backwards compatibility)
  createCharacter: protectedProcedure
    .input(createCharacterFromUploadSchema)
    .use(isProjectOwner)
    .mutation(async ({ ctx, input }) => {
      const character = await dbWrite.comicCharacter.create({
        data: {
          projectId: input.projectId,
          userId: ctx.user!.id,
          name: input.name,
          sourceType: ComicCharacterSourceType.Upload,
          referenceImages: input.referenceImages,
          status: ComicCharacterStatus.Pending,
        },
      });

      return character;
    }),

  // Internal: called by training pipeline webhooks to update character status.
  // Restricted transitions prevent users from bypassing training.
  updateCharacterStatus: protectedProcedure
    .input(updateCharacterStatusSchema)
    .mutation(async ({ ctx, input }) => {
      const character = await dbRead.comicCharacter.findUnique({
        where: { id: input.characterId },
        select: { userId: true, status: true, sourceType: true },
      });

      if (!character || character.userId !== ctx.user.id) {
        throw throwAuthorizationError();
      }

      // Only allow valid status transitions for Upload characters
      // ExistingModel characters are managed by pollCharacterStatus
      if (character.sourceType === ComicCharacterSourceType.ExistingModel) {
        throw throwBadRequestError('Cannot change status of a model-linked character');
      }

      const allowedTransitions: Record<string, string[]> = {
        [ComicCharacterStatus.Pending]: [ComicCharacterStatus.Processing, ComicCharacterStatus.Failed],
        [ComicCharacterStatus.Processing]: [ComicCharacterStatus.Ready, ComicCharacterStatus.Failed],
        [ComicCharacterStatus.Failed]: [ComicCharacterStatus.Pending], // allow retry
      };

      const allowed = allowedTransitions[character.status] ?? [];
      if (!allowed.includes(input.status)) {
        throw throwBadRequestError(
          `Cannot transition from ${character.status} to ${input.status}`
        );
      }

      const updated = await dbWrite.comicCharacter.update({
        where: { id: input.characterId },
        data: {
          status: input.status,
          trainingJobId: input.trainingJobId,
          trainedModelId: input.trainedModelId,
          trainedModelVersionId: input.trainedModelVersionId,
          errorMessage: input.errorMessage,
        },
      });

      return updated;
    }),

  getCharacter: protectedProcedure
    .input(z.object({ characterId: z.string() }))
    .query(async ({ ctx, input }) => {
      const character = await dbRead.comicCharacter.findUnique({
        where: { id: input.characterId },
      });

      if (!character || character.userId !== ctx.user.id) {
        throw throwAuthorizationError();
      }

      return character;
    }),

  deleteCharacter: protectedProcedure
    .input(deleteCharacterSchema)
    .mutation(async ({ ctx, input }) => {
      const character = await dbRead.comicCharacter.findUnique({
        where: { id: input.characterId },
        select: { userId: true },
      });

      if (!character || character.userId !== ctx.user.id) {
        throw throwAuthorizationError();
      }

      await dbWrite.comicCharacter.delete({
        where: { id: input.characterId },
      });

      return { success: true };
    }),

  // Search user's models for character selection
  // Images are fetched separately on the frontend via image.getEntitiesCoverImage
  searchMyModels: protectedProcedure
    .input(z.object({
      query: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }))
    .query(async ({ ctx, input }) => {
      const models = await dbRead.model.findMany({
        where: {
          userId: ctx.user.id,
          type: 'LORA',
          ...(input.query && {
            name: { contains: input.query, mode: 'insensitive' },
          }),
          // Only models that have at least one version with generation coverage
          modelVersions: {
            some: {
              generationCoverage: { covered: true },
            },
          },
        },
        select: {
          id: true,
          name: true,
          modelVersions: {
            where: {
              generationCoverage: { covered: true },
            },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              id: true,
              name: true,
              baseModel: true,
            },
          },
        },
        take: input.limit,
        orderBy: { updatedAt: 'desc' },
      });

      return models
        .map((m) => {
          const version = m.modelVersions[0];
          return {
            id: m.id,
            name: m.name,
            versionId: version?.id,
            versionName: version?.name,
            baseModel: version?.baseModel,
          };
        })
        .filter((m) => m.versionId);
    }),

  // Panels — NanoBanana generation via createImageGen
  createPanel: protectedProcedure
    .input(createPanelSchema)
    .use(isChapterOwner)
    .mutation(async ({ ctx, input }) => {
      // Verify chapter ownership and get project info + all character names
      const chapter = await dbRead.comicChapter.findUnique({
        where: { id: input.chapterId },
        include: {
          project: {
            select: {
              id: true,
              userId: true,
              characters: {
                where: { status: ComicCharacterStatus.Ready },
                select: { name: true },
              },
            },
          },
        },
      });
      if (!chapter || chapter.project.userId !== ctx.user!.id) {
        throw throwAuthorizationError();
      }

      const allCharacterNames = chapter.project.characters.map((c) => c.name);

      // If inserting at a specific position, shift existing panels and get the
      // panel just before the insertion point for context. Otherwise use the last panel.
      let nextPosition: number;
      let contextPanel: { id: string; position: number; prompt: string; enhancedPrompt: string | null; imageUrl: string | null } | null;

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
        // Appending: use the last panel for context
        contextPanel = await dbRead.comicPanel.findFirst({
          where: { chapterId: input.chapterId },
          orderBy: { position: 'desc' },
          select: { id: true, position: true, prompt: true, enhancedPrompt: true, imageUrl: true },
        });
        nextPosition = (contextPanel?.position ?? -1) + 1;
      }

      // Get character's reference images for generation
      let characterName = '';
      let characterRefImages: { url: string; width: number; height: number }[] = [];
      if (input.characterId) {
        const character = await dbRead.comicCharacter.findUnique({
          where: { id: input.characterId },
          select: {
            name: true,
            generatedReferenceImages: true,
            referenceImages: true,
            sourceType: true,
            status: true,
          },
        });

        if (character) {
          characterName = character.name;

          // Use generated reference images (from LoRA generation or user upload)
          if (character.generatedReferenceImages) {
            const genRefs = character.generatedReferenceImages as {
              url: string;
              width: number;
              height: number;
              view: string;
            }[];
            characterRefImages = genRefs.map((r) => ({
              // Resolve CF image IDs to full URLs for the orchestrator
              url: getEdgeUrl(r.url, { original: true }),
              width: r.width,
              height: r.height,
            }));
          }
          // Fallback: use uploaded reference images (legacy)
          else if (character.referenceImages) {
            const uploadedRefs = character.referenceImages as string[];
            characterRefImages = uploadedRefs.map((url) => ({
              url: getEdgeUrl(url, { original: true }),
              width: 512,
              height: 512,
            }));
          }
        }
      }

      if (characterRefImages.length === 0) {
        throw throwBadRequestError('Character has no reference images');
      }

      // Build prompt — optionally enhance via LLM
      let fullPrompt: string;
      if (input.enhance) {
        fullPrompt = await enhanceComicPrompt({
          userPrompt: input.prompt,
          characterName,
          characterNames: allCharacterNames,
          previousPanel: contextPanel ?? undefined,
        });
      } else {
        fullPrompt = input.prompt;
      }

      // Build metadata for debugging
      const metadata = {
        previousPanelId: contextPanel?.id ?? null,
        previousPanelPrompt: contextPanel
          ? (contextPanel.enhancedPrompt ?? contextPanel.prompt)
          : null,
        previousPanelImageUrl: contextPanel?.imageUrl ?? null,
        referenceImages: characterRefImages,
        enhanceEnabled: input.enhance,
        characterName,
        allCharacterNames,
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
          characterId: input.characterId,
          prompt: input.prompt,
          enhancedPrompt: input.enhance ? fullPrompt : null,
          position: nextPosition,
          status: ComicPanelStatus.Pending,
          metadata,
        },
      });

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
            images: characterRefImages,
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

  updatePanel: protectedProcedure
    .input(updatePanelSchema)
    .mutation(async ({ ctx, input }) => {
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

  deletePanel: protectedProcedure
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
          character: {
            select: {
              id: true,
              name: true,
              sourceType: true,
              modelId: true,
              modelVersionId: true,
              trainedModelVersionId: true,
              generatedReferenceImages: true,
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

      // Get character reference images info
      const character = panel.character;

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
        character: character
          ? {
              id: character.id,
              name: character.name,
              sourceType: character.sourceType,
              generatedReferenceImages: character.generatedReferenceImages,
            }
          : null,
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
          firstStep?.output?.images?.[0]?.url ??
          firstStep?.output?.blobs?.[0]?.url ??
          null;

        if (imageUrl) {
          const updated = await dbWrite.comicPanel.update({
            where: { id: panel.id },
            data: {
              status: ComicPanelStatus.Ready,
              imageUrl,
            },
          });
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
});
