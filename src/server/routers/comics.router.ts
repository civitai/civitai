import { z } from 'zod';
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
  projectId: z.string(),
  characterId: z.string().optional(),
  prompt: z.string().min(1).max(2000),
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
  projectId: z.string(),
  panelIds: z.array(z.string()),
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
        _count: {
          select: { panels: true },
        },
        panels: {
          take: 1,
          orderBy: { position: 'asc' },
          select: { imageUrl: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      panelCount: p._count.panels,
      thumbnailUrl: p.panels[0]?.imageUrl ?? null,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));
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
          panels: {
            orderBy: { position: 'asc' },
          },
        },
      });

      if (!project || project.userId !== ctx.user.id) {
        throw throwAuthorizationError();
      }

      return project;
    }),

  createProject: protectedProcedure
    .input(createProjectSchema)
    .mutation(async ({ ctx, input }) => {
      const project = await dbWrite.comicProject.create({
        data: {
          userId: ctx.user.id,
          name: input.name,
        },
      });

      return project;
    }),

  deleteProject: protectedProcedure
    .input(getProjectSchema)
    .use(isProjectOwner)
    .mutation(async ({ input }) => {
      await dbWrite.comicProject.update({
        where: { id: input.id },
        data: { status: ComicProjectStatus.Deleted },
      });

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
          userId: ctx.user.id,
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

  // Path 2: Create character from existing LoRA model (instant)
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
      const isOwner = modelVersion.model.userId === ctx.user.id;
      const isPublished = modelVersion.model.status === 'Published';

      if (!isOwner && !isPublished) {
        throw throwAuthorizationError('You do not have access to this model');
      }

      const character = await dbWrite.comicCharacter.create({
        data: {
          projectId: input.projectId,
          userId: ctx.user.id,
          name: input.name,
          sourceType: ComicCharacterSourceType.ExistingModel,
          modelId: input.modelId,
          modelVersionId: input.modelVersionId,
          status: ComicCharacterStatus.Ready, // Instant - no training needed
        },
      });

      return character;
    }),

  // Legacy endpoint - routes to upload flow (for backwards compatibility)
  createCharacter: protectedProcedure
    .input(createCharacterFromUploadSchema)
    .use(isProjectOwner)
    .mutation(async ({ ctx, input }) => {
      const character = await dbWrite.comicCharacter.create({
        data: {
          projectId: input.projectId,
          userId: ctx.user.id,
          name: input.name,
          sourceType: ComicCharacterSourceType.Upload,
          referenceImages: input.referenceImages,
          status: ComicCharacterStatus.Pending,
        },
      });

      return character;
    }),

  updateCharacterStatus: protectedProcedure
    .input(updateCharacterStatusSchema)
    .mutation(async ({ ctx, input }) => {
      // Verify ownership
      const character = await dbRead.comicCharacter.findUnique({
        where: { id: input.characterId },
        select: { userId: true },
      });

      if (!character || character.userId !== ctx.user.id) {
        throw throwAuthorizationError();
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

  // Search user's models for character selection
  searchMyModels: protectedProcedure
    .input(z.object({
      query: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }))
    .query(async ({ ctx, input }) => {
      const models = await dbRead.model.findMany({
        where: {
          userId: ctx.user.id,
          status: 'Published',
          type: 'LORA', // Only LoRAs for character consistency
          ...(input.query && {
            name: { contains: input.query, mode: 'insensitive' },
          }),
        },
        select: {
          id: true,
          name: true,
          modelVersions: {
            where: { status: 'Published' },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              id: true,
              name: true,
              images: {
                take: 1,
                select: { url: true },
              },
            },
          },
        },
        take: input.limit,
        orderBy: { updatedAt: 'desc' },
      });

      return models.map((m) => ({
        id: m.id,
        name: m.name,
        versionId: m.modelVersions[0]?.id,
        versionName: m.modelVersions[0]?.name,
        imageUrl: m.modelVersions[0]?.images[0]?.url,
      })).filter((m) => m.versionId); // Only return models with at least one version
    }),

  // Panels
  createPanel: protectedProcedure
    .input(createPanelSchema)
    .use(isProjectOwner)
    .mutation(async ({ input }) => {
      // Get the next position
      const lastPanel = await dbRead.comicPanel.findFirst({
        where: { projectId: input.projectId },
        orderBy: { position: 'desc' },
        select: { position: true },
      });

      const nextPosition = (lastPanel?.position ?? -1) + 1;

      // Get character's model version for generation
      let modelVersionId: number | null = null;
      if (input.characterId) {
        const character = await dbRead.comicCharacter.findUnique({
          where: { id: input.characterId },
          select: {
            modelVersionId: true,
            trainedModelVersionId: true,
            sourceType: true,
          },
        });

        if (character) {
          // Use the appropriate model version based on source type
          modelVersionId = character.sourceType === ComicCharacterSourceType.ExistingModel
            ? character.modelVersionId
            : character.trainedModelVersionId;
        }
      }

      const panel = await dbWrite.comicPanel.create({
        data: {
          projectId: input.projectId,
          characterId: input.characterId,
          prompt: input.prompt,
          position: nextPosition,
          status: ComicPanelStatus.Pending,
        },
      });

      // TODO: Trigger generation job via orchestrator
      // - Use modelVersionId as LoRA for the generation
      // - Pass prompt and default settings
      // - Update panel status and imageUrl when complete

      return panel;
    }),

  updatePanel: protectedProcedure
    .input(updatePanelSchema)
    .mutation(async ({ ctx, input }) => {
      // Verify ownership via project
      const panel = await dbRead.comicPanel.findUnique({
        where: { id: input.panelId },
        include: { project: { select: { userId: true } } },
      });

      if (!panel || panel.project.userId !== ctx.user.id) {
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
      // Verify ownership via project
      const panel = await dbRead.comicPanel.findUnique({
        where: { id: input.panelId },
        include: { project: { select: { userId: true } } },
      });

      if (!panel || panel.project.userId !== ctx.user.id) {
        throw throwAuthorizationError();
      }

      await dbWrite.comicPanel.delete({
        where: { id: input.panelId },
      });

      return { success: true };
    }),

  reorderPanels: protectedProcedure
    .input(reorderPanelsSchema)
    .use(isProjectOwner)
    .mutation(async ({ input }) => {
      // Update positions based on array order
      const updates = input.panelIds.map((id, index) =>
        dbWrite.comicPanel.update({
          where: { id },
          data: { position: index },
        })
      );

      await Promise.all(updates);

      return { success: true };
    }),
});
