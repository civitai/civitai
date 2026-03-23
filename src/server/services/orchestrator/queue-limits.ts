import { TRPCError } from '@trpc/server';
import type { UserTier } from '~/server/schema/user.schema';
import { defaultsByTier } from '~/server/schema/generation.schema';
import { getGenerationStatus } from '~/server/services/generation/generation.service';
import { queryWorkflows } from '~/server/services/orchestrator/workflows';
import { POLLABLE_STATUSES } from '~/shared/constants/orchestrator.constants';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';

// =============================================================================
// Types
// =============================================================================

export interface QueueStatus {
  /** Number of queue slots currently in use */
  used: number;
  /** Total queue slots for this user tier */
  limit: number;
  /** Number of available slots (limit - used) */
  available: number;
  /** Whether the user can generate (has slots and generation is available) */
  canGenerate: boolean;
}

export interface WaitForSlotOptions {
  /** Timeout in milliseconds (default: 5 minutes) */
  timeoutMs?: number;
  /** Callback when waiting for a slot */
  onWaiting?: (status: QueueStatus, elapsedMs: number) => void;
}

// =============================================================================
// Constants
// =============================================================================

/** How often to poll for queue slot availability */
const SLOT_POLL_INTERVAL_MS = 3000;

/** Default maximum time to wait for a slot (5 minutes) */
const DEFAULT_MAX_WAIT_TIME_MS = 5 * 60 * 1000;

// =============================================================================
// Queue Status Functions
// =============================================================================

/**
 * Get the current queue status for a user.
 * Queries the orchestrator for active workflows and calculates available slots.
 */
export async function getUserQueueStatus(
  token: string,
  userTier: UserTier = 'free'
): Promise<QueueStatus> {
  // Get tier-based limits from Redis/config
  const generationStatus = await getGenerationStatus();
  const limits = generationStatus.limits[userTier] ?? defaultsByTier[userTier];
  const queueLimit = limits.queue;

  // Query recent active workflows for this user
  // We use excludeFailed to skip completed failures, then filter by POLLABLE_STATUSES
  const { items: workflows } = await queryWorkflows({
    token,
    tags: [WORKFLOW_TAGS.GENERATION],
    take: queueLimit + 5, // Fetch slightly more than limit to be safe
    excludeFailed: true,
    hideMatureContent: false,
  });

  // Filter to only count in-progress workflows (pending or processing)
  const activeWorkflows = (workflows ?? []).filter((wf) =>
    POLLABLE_STATUSES.includes(wf.status as any)
  );

  const used = activeWorkflows.length;
  const available = Math.max(0, queueLimit - used);

  return {
    used,
    limit: queueLimit,
    available,
    canGenerate: available > 0 && generationStatus.available,
  };
}

/**
 * Assert that the user can generate the requested number of items.
 * Throws a TRPCError if not enough queue slots are available.
 *
 * Use this for single-item generation endpoints that should fail immediately.
 */
export async function assertCanGenerate(
  token: string,
  userTier: UserTier,
  requestedSlots: number = 1
): Promise<QueueStatus> {
  const status = await getUserQueueStatus(token, userTier);

  // Check if generation is globally disabled (separate from queue fullness)
  if (!status.canGenerate && status.available >= requestedSlots) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Image generation is currently unavailable. Please try again later.',
    });
  }

  if (status.available < requestedSlots) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message:
        requestedSlots === 1
          ? `Queue limit reached. You have ${status.used}/${status.limit} jobs running. Please wait for a job to complete.`
          : `Not enough queue slots. You need ${requestedSlots} slots but only have ${status.available} available (${status.used}/${status.limit} in use).`,
    });
  }

  return status;
}

/**
 * Wait for a queue slot to become available.
 * Polls the orchestrator until a slot opens or timeout is reached.
 *
 * Use this for multi-item generation (Smart Create) where we want to wait
 * rather than fail immediately.
 */
export async function waitForQueueSlot(
  token: string,
  userTier: UserTier,
  requiredSlots: number = 1,
  options?: WaitForSlotOptions
): Promise<QueueStatus> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_MAX_WAIT_TIME_MS;
  const startTime = Date.now();

  while (true) {
    const status = await getUserQueueStatus(token, userTier);

    // Check if we have enough slots
    if (status.available >= requiredSlots) {
      return status;
    }

    // Check timeout
    const elapsedMs = Date.now() - startTime;
    if (elapsedMs >= timeoutMs) {
      throw new TRPCError({
        code: 'TIMEOUT',
        message: `Timed out waiting for queue slot after ${Math.round(elapsedMs / 1000)} seconds. You have ${status.used}/${status.limit} jobs running.`,
      });
    }

    // Notify caller we're waiting (for logging/progress)
    options?.onWaiting?.(status, elapsedMs);

    // Wait before polling again
    await sleep(SLOT_POLL_INTERVAL_MS);
  }
}

// =============================================================================
// Helpers
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
