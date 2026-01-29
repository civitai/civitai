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
import { getWorkflow } from '~/server/services/orchestrator/workflows';

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
      const isOwner = modelVersion.model.userId === ctx.user.id;
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
      // ExistingModel characters are set to Ready on creation and shouldn't change
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

  // Panels
  createPanel: protectedProcedure
    .input(createPanelSchema)
    .use(isProjectOwner)
    .mutation(async ({ ctx, input }) => {
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
          modelVersionId = character.sourceType === ComicCharacterSourceType.ExistingModel
            ? character.modelVersionId
            : character.trainedModelVersionId;
        }
      }

      if (!modelVersionId) {
        throw throwBadRequestError('Character has no model version');
      }

      // Get the LoRA's baseModel to determine compatible checkpoint
      const modelVersion = await dbRead.modelVersion.findUnique({
        where: { id: modelVersionId },
        select: { baseModel: true, trainedWords: true },
      });
      if (!modelVersion) {
        throw throwBadRequestError('Model version not found');
      }

      const baseModelGroup = getBaseModelSetType(modelVersion.baseModel);
      const config = getGenerationConfig(baseModelGroup);
      const checkpointVersionId = config.checkpoint.id;

      // Build prompt with trained words if available
      const trainedWords = modelVersion.trainedWords ?? [];
      const fullPrompt = trainedWords.length > 0
        ? `${trainedWords.join(', ')}, ${input.prompt}`
        : input.prompt;

      // Create panel record as Pending (not yet submitted to orchestrator)
      const panel = await dbWrite.comicPanel.create({
        data: {
          projectId: input.projectId,
          characterId: input.characterId,
          prompt: input.prompt,
          position: nextPosition,
          status: ComicPanelStatus.Pending,
        },
      });

      // Submit generation workflow
      try {
        const token = await getOrchestratorToken(ctx.user!.id, ctx);
        const result = await createTextToImage({
          params: {
            prompt: fullPrompt,
            negativePrompt: '',
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
            { id: modelVersionId, strength: 1 },
          ],
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
          modelVersionId,
          baseModelGroup,
          checkpointVersionId,
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
      // Verify all panels belong to this project
      const panels = await dbRead.comicPanel.findMany({
        where: { projectId: input.projectId },
        select: { id: true },
      });
      const projectPanelIds = new Set(panels.map((p) => p.id));
      for (const id of input.panelIds) {
        if (!projectPanelIds.has(id)) {
          throw throwBadRequestError('Panel does not belong to this project');
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
          project: { select: { userId: true, baseModel: true } },
          character: {
            select: {
              id: true,
              name: true,
              sourceType: true,
              modelId: true,
              modelVersionId: true,
              trainedModelVersionId: true,
            },
          },
        },
      });

      if (!panel || panel.project.userId !== ctx.user!.id) {
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

      // Get model version info if character is linked
      let modelVersionInfo: any = null;
      const character = panel.character;
      if (character) {
        const mvId = character.sourceType === 'ExistingModel'
          ? character.modelVersionId
          : character.trainedModelVersionId;
        if (mvId) {
          const mv = await dbRead.modelVersion.findUnique({
            where: { id: mvId },
            select: {
              id: true,
              baseModel: true,
              trainedWords: true,
              status: true,
              model: { select: { id: true, name: true, type: true, status: true } },
            },
          });
          if (mv) {
            const baseModelGroup = getBaseModelSetType(mv.baseModel);
            const config = getGenerationConfig(baseModelGroup);
            modelVersionInfo = {
              versionId: mv.id,
              baseModel: mv.baseModel,
              baseModelGroup,
              trainedWords: mv.trainedWords,
              status: mv.status,
              model: mv.model,
              checkpoint: {
                id: config.checkpoint.id,
                name: config.checkpoint.model?.name,
              },
            };
          }
        }
      }

      return {
        panel: {
          id: panel.id,
          status: panel.status,
          prompt: panel.prompt,
          imageUrl: panel.imageUrl,
          workflowId: panel.workflowId,
          errorMessage: panel.errorMessage,
          createdAt: panel.createdAt,
          updatedAt: panel.updatedAt,
        },
        project: {
          baseModel: panel.project.baseModel,
        },
        character: character
          ? { id: character.id, name: character.name, sourceType: character.sourceType }
          : null,
        modelVersion: modelVersionInfo,
        workflow: workflowInfo,
      };
    }),

  // Poll panel generation status
  pollPanelStatus: protectedProcedure
    .input(z.object({ panelId: z.string() }))
    .query(async ({ ctx, input }) => {
      const panel = await dbRead.comicPanel.findUnique({
        where: { id: input.panelId },
        include: { project: { select: { userId: true } } },
      });

      if (!panel || panel.project.userId !== ctx.user!.id) {
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
        // (e.g. status may still be 'scheduled' when output images are already available).
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
          // Workflow done but no image URL — unusual, mark ready anyway
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
