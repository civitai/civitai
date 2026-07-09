import { dbRead, dbWrite } from '~/server/db/client';
import { createLogger } from '~/utils/logging';
import { createJob } from './job';
import { ComicPanelStatus } from '~/shared/utils/prisma/enums';
import { getUserQueueStatus } from '~/server/services/orchestrator/queue-limits';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import {
  findPresetModelConfigByVersionId,
  submitPresetImageGen,
} from '~/server/services/orchestrator/preset-image-gen.service';
import { getHighestTierSubscription } from '~/server/services/subscriptions.service';
import { SignalMessages } from '~/server/common/enums';
import { signalClient } from '~/utils/signal-client';
import type { SessionUser } from '~/types/session';
import type { UserTier } from '~/server/schema/user.schema';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';

const log = createLogger('process-enqueued-comic-panels', 'cyan');

// Process at most this many panels per job run to avoid long-running jobs
const MAX_PANELS_PER_RUN = 20;

/**
 * Job to process enqueued comic panels.
 * Runs every 30 seconds to check for panels that can be submitted to the orchestrator.
 *
 * For each user with enqueued panels:
 * 1. Check their queue status
 * 2. If slots available, submit panels (oldest first)
 * 3. Update panel status to Generating
 */
export const processEnqueuedComicPanelsJob = createJob(
  'process-enqueued-comic-panels',
  '*/30 * * * * *', // Every 30 seconds
  async (jobContext) => {
    log('Starting enqueued comic panels processing');

    // Find all enqueued panels with user info via chapter -> project -> user
    const enqueuedPanels = await dbRead.comicPanel.findMany({
      where: { status: ComicPanelStatus.Enqueued },
      include: {
        chapter: {
          select: {
            project: {
              select: {
                userId: true,
                user: {
                  select: {
                    id: true,
                    username: true,
                    email: true,
                    image: true,
                    deletedAt: true,
                    bannedAt: true,
                    muted: true,
                    isModerator: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: [{ projectId: 'asc' }, { chapterPosition: 'asc' }, { position: 'asc' }],
      take: MAX_PANELS_PER_RUN * 5, // Fetch extra to handle multiple users
    });

    if (enqueuedPanels.length === 0) {
      log('No enqueued panels found');
      return { processed: 0 };
    }

    log(`Found ${enqueuedPanels.length} enqueued panels`);

    // Group panels by user
    const panelsByUser = new Map<number, typeof enqueuedPanels>();
    for (const panel of enqueuedPanels) {
      const userId = panel.chapter.project.userId;
      if (!panelsByUser.has(userId)) {
        panelsByUser.set(userId, []);
      }
      panelsByUser.get(userId)!.push(panel);
    }

    let totalProcessed = 0;
    let totalFailed = 0;

    // Process each user's panels
    for (const [userId, userPanels] of panelsByUser) {
      jobContext.checkIfCanceled();

      if (totalProcessed >= MAX_PANELS_PER_RUN) break;

      const firstPanel = userPanels[0];
      const user = firstPanel.chapter.project.user;

      // Skip deleted or banned users — this job bypasses tRPC auth middleware
      if (user.deletedAt || user.bannedAt) {
        log(`User ${userId}: Skipping — account is ${user.deletedAt ? 'deleted' : 'banned'}`);
        // Mark their panels as failed so they don't get retried
        for (const panel of userPanels) {
          await dbWrite.comicPanel.update({
            where: { id: panel.id },
            data: {
              status: ComicPanelStatus.Failed,
              errorMessage: `User account is ${user.deletedAt ? 'deleted' : 'banned'}`,
            },
          });
          totalFailed++;
        }
        continue;
      }

      try {
        // Get user's tier from their active subscriptions
        const highestSub = await getHighestTierSubscription(userId);
        const userTier = (highestSub?.tier ?? 'free') as UserTier;
        // Merge tier into user object for submitPresetImageGen which expects SessionUser
        const sessionUser = { ...user, tier: userTier } as SessionUser;

        // Get user's token and queue status
        // Note: getOrchestratorToken uses Redis store (not cookies), so ctx is unused
        // but still required by the type signature. Pass a minimal stub.
        const token = await getOrchestratorToken(userId, {} as any);
        const queueStatus = await getUserQueueStatus(token, userTier);

        if (!queueStatus.canGenerate || queueStatus.available === 0) {
          log(
            `User ${userId}: Queue full (${queueStatus.used}/${queueStatus.limit}), skipping ${userPanels.length} panels`
          );
          continue;
        }

        // Process up to available slots
        const panelsToProcess = userPanels.slice(
          0,
          Math.min(queueStatus.available, MAX_PANELS_PER_RUN - totalProcessed)
        );
        log(
          `User ${userId}: Processing ${panelsToProcess.length} of ${userPanels.length} panels (${queueStatus.available} slots available)`
        );

        for (const panel of panelsToProcess) {
          jobContext.checkIfCanceled();

          try {
            const metadata = panel.metadata as any;
            if (!metadata?.generationParams) {
              log(`Panel ${panel.id}: Missing generationParams in metadata, marking as failed`);
              await dbWrite.comicPanel.update({
                where: { id: panel.id },
                data: {
                  status: ComicPanelStatus.Failed,
                  errorMessage: 'Missing generation parameters',
                },
              });
              totalFailed++;
              continue;
            }

            const { generationParams, referenceImages, maxReferenceImages } = metadata;
            const isGreen = metadata.isGreen === true;

            // Resolve the preset model config from the persisted version id (the
            // job stores the version id, not the app-facing model key).
            const modelConfig = findPresetModelConfigByVersionId(
              generationParams.checkpointVersionId
            );
            if (!modelConfig) {
              log(
                `Panel ${panel.id}: Unknown checkpoint version ${generationParams.checkpointVersionId}, marking as failed`
              );
              await dbWrite.comicPanel.update({
                where: { id: panel.id },
                data: {
                  status: ComicPanelStatus.Failed,
                  errorMessage: `Unknown checkpoint version ${generationParams.checkpointVersionId}`,
                },
              });
              totalFailed++;
              continue;
            }

            // Cap reference images (simple slice)
            const images = (referenceImages || []).slice(0, maxReferenceImages || 3);

            // Determine currencies based on the domain the panel was created on
            const currencies: BuzzSpendType[] = isGreen ? ['green', 'blue'] : ['yellow', 'blue'];
            const tags = isGreen ? ['comics', 'green'] : ['comics'];

            // Audit prompt before submitting. Unlike the interactive comics/iterate
            // paths (which rely on `generateFromGraph`'s internal audit), this job
            // runs outside the tRPC request path, so we keep an explicit pre-submit
            // gate here. `generateFromGraph` will also audit, but auditing twice in
            // a background job is an acceptable cost for the early gate.
            await auditPromptServer({
              prompt: generationParams.prompt,
              negativePrompt: generationParams.negativePrompt || '',
              userId,
              isGreen,
              isModerator: sessionUser.isModerator,
            });

            // Submit to orchestrator via the generation graph. `versionIdOverride`
            // preserves the exact persisted version (incl. img2img variants).
            const result = await submitPresetImageGen({
              prompt: generationParams.prompt,
              aspectRatio: metadata.aspectRatio,
              quantity: metadata.quantity ?? 1,
              images,
              modelConfig,
              versionIdOverride: generationParams.checkpointVersionId,
              user: sessionUser,
              token,
              currencies,
              tags,
              isGreen,
              allowMatureContent: isGreen ? false : undefined,
            });

            // Update panel status
            await dbWrite.comicPanel.update({
              where: { id: panel.id },
              data: {
                workflowId: result.id,
                status: ComicPanelStatus.Generating,
              },
            });

            totalProcessed++;
            log(`Panel ${panel.id}: Submitted to orchestrator (workflowId: ${result.id})`);

            // Signal the user so the frontend picks up the Enqueued → Generating transition
            await signalClient
              .send({
                userId,
                target: SignalMessages.ComicPanelUpdate,
                data: {
                  panelId: panel.id,
                  projectId: panel.projectId,
                  status: ComicPanelStatus.Generating,
                  workflowId: result.id,
                },
              })
              .catch(() => null); // Don't fail the job if signal fails
          } catch (error: any) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log(`Panel ${panel.id}: Failed to submit - ${errorMessage}`);

            await dbWrite.comicPanel.update({
              where: { id: panel.id },
              data: {
                status: ComicPanelStatus.Failed,
                errorMessage: `Job processing failed: ${errorMessage}`,
              },
            });
            totalFailed++;
          }
        }
      } catch (error: any) {
        log(`User ${userId}: Error getting queue status - ${error.message}`);
      }
    }

    log(`Completed: ${totalProcessed} processed, ${totalFailed} failed`);
    return { processed: totalProcessed, failed: totalFailed };
  },
  {
    shouldWait: false,
    lockExpiration: 5 * 60, // 5 minute lock to prevent double-submission across job ticks
  }
);
