import type { Workflow } from '@civitai/orchestration-client';
import { TRPCError } from '@trpc/server';
import type {
  BlockWorkflowOutput,
  BlockWorkflowSnapshot,
} from '~/server/schema/blocks/workflow.schema';
import {
  blockOutputCeilingFromClaims,
  isUnrestrictedOutput,
  pendingOutputMessage,
  type BlockOutputCeiling,
} from '~/server/services/blocks/block-output-restriction';
import { resolveViewerBrowsingLevel } from '~/server/services/blocks/block-viewer-ceiling';
import {
  assertBlockWorkflowMintedForViewer,
  assertBlockWorkflowTaggedForApp,
} from '~/server/services/blocks/block-workflow-access';
import { snapshotFromWorkflow } from '~/server/services/blocks/workflow.service';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

/**
 * Unlocking ONE restricted App Block workflow output, in place, from the host's own dialog.
 *
 * What can be unlocked is decided here from the LIVE workflow and the verified token, never from
 * what the app says about the output:
 *   - `{ restricted, reason: 'pool' }`: the paying Buzz pool refused mature content. This is the
 *     only unlockable reason. The unlock is civitai.com's "Unlock with yellow Buzz": the
 *     orchestrator charges the generation's cost in Yellow Buzz and refunds the pool that paid.
 *     A 'pool' output has already passed the viewer's output ceiling and the workflow's own cap
 *     (`classifyBlockOutput` rules 3 and 4 run before rule 5), so unlocking it can never hand
 *     the app a url above the viewer's ceiling.
 *   - `'ceiling'` and `'unrated'` (treated alike): never charged. When the DOMAIN is what keeps
 *     it out and civitai.red would show it, the host links out (`link-out`). When the domain
 *     already covers it and the viewer's own browsing level is what cuts it, a link to red does
 *     nothing, so the reply is `unavailable` with a pointer to their settings.
 *
 * The money path ({@link unlockBlockOutput}) runs under a per-workflow lock, reserves the
 * viewer's daily Buzz limit BEFORE the orchestrator is asked, and re-classifies the workflow at
 * the token's ceiling afterwards; every path that releases nothing refunds the reservation.
 *
 * NO AUTHOR SHARE ON AN UNLOCK (operator decision). The only charge is the orchestrator's yellow
 * swap. A generation whose spend accrued an author fee already paid the author once; one whose
 * spend took no fee has none to repeat. So nothing here reaches `chargeBlockAuthorFee`.
 */

/** How long a single unlock may hold its workflow's lock. */
export const OUTPUT_UNLOCK_LOCK_TTL_SECONDS = 300;

/**
 * The bound on the orchestrator write that lifts the restriction. Every other orchestrator call
 * under the lock is a read with its own 20s timeout (`ORCHESTRATOR_GET_TIMEOUT_MS`); there are
 * at most four (the plan, the release check, the update's own read-back, the re-classify), so
 * the lock's TTL must exceed this plus 80s. Pinned in the tests.
 */
export const OUTPUT_UNLOCK_ORCHESTRATOR_TIMEOUT_MS = 30_000;

/** The orchestrator read timeout the TTL above is sized against (mirrors `workflows.ts`). */
export const OUTPUT_UNLOCK_READ_TIMEOUT_MS = 20_000;

/** The claims this module reads. All come from the verified block token. */
export type OutputUnlockClaims = {
  sub?: string;
  appId: string;
  maxBrowsingLevel?: number | null;
  viewerBrowsingLevel?: number | null;
};

export const OUTPUT_UNLOCK_SETTINGS_MESSAGE =
  'This output is above your browsing level. Change your mature content settings to view it.';
export const OUTPUT_UNLOCK_CANNOT_SHOW_MESSAGE = 'This output cannot be shown here.';
export const OUTPUT_UNLOCK_BLOCKED_MESSAGE =
  'This output was blocked by moderation and cannot be unlocked.';
export const OUTPUT_UNLOCK_LINK_OUT_MESSAGE =
  'This output is mature content. Open it on civitai.red to view it.';
export const OUTPUT_UNLOCK_IN_PROGRESS_MESSAGE = 'This output is already being unlocked.';
export const OUTPUT_UNLOCK_PRICE_CHANGED_MESSAGE =
  'The unlock price changed. Review the new price and confirm again.';

/** Every rating's bit, PG through XXX: what civitai.red can show a viewer with mature on. */
const ALL_RATINGS_CEILING: BlockOutputCeiling = { maxBrowsingLevel: allBrowsingLevelsFlag };

export type OutputUnlockPlan =
  /** Unlockable: `unlockBuzz` is the orchestrator's yellow charge, the whole price. */
  | { kind: 'pay'; position: number; unlockBuzz: number; snapshot: BlockWorkflowSnapshot }
  | { kind: 'link-out'; position: number; message: string }
  | { kind: 'unavailable'; position: number; message: string }
  /** The output already carries a url: nothing to unlock and nothing to charge. */
  | { kind: 'not-restricted'; position: number; snapshot: BlockWorkflowSnapshot };

/**
 * The snapshot at `ceiling` and its output at `position`. The ONE call into
 * `snapshotFromWorkflow` in this module (ledgered in
 * `block-output-restriction.producer-ledger.test.ts`). Only the call with the token's own
 * ceiling ever reaches the app; the domain-only and all-ratings calls in
 * {@link planBlockOutputUnlock} decide where to send the viewer and are then discarded.
 */
function outputAt(
  workflow: Workflow,
  ceiling: BlockOutputCeiling,
  position: number
): { snapshot: BlockWorkflowSnapshot; output: BlockWorkflowOutput | undefined } {
  const snapshot = snapshotFromWorkflow(workflow, ceiling);
  return { snapshot, output: snapshot.outputs?.[position] };
}

/** Shown, or unlockable by paying: either way the viewer could see it under that ceiling. */
function viewable(output: BlockWorkflowOutput | undefined): boolean {
  if (!output) return false;
  if (isUnrestrictedOutput(output)) return true;
  return 'restricted' in output && output.reason === 'pool';
}

/**
 * The orchestrator's yellow price for lifting the restriction: what the generation drained from
 * every non-yellow pool, net of credits. The same reduction civitai.com's own unlock button
 * shows (`CanUpgradeBlock` in `QueueItem.tsx`).
 */
export function unlockPriceFromTransactions(
  list: ReadonlyArray<{ type?: string | null; amount?: number | null; accountType?: string | null }>
): number {
  const net = list.reduce((acc, t) => {
    if (t.accountType === 'yellow') return acc;
    const amount = typeof t.amount === 'number' && Number.isFinite(t.amount) ? t.amount : 0;
    return t.type === 'credit' ? acc - amount : acc + amount;
  }, 0);
  return Math.max(0, Math.ceil(net));
}

/**
 * What the host may offer for the output at `position`. Pure: reads only the workflow and the
 * token claims.
 */
export function planBlockOutputUnlock(
  workflow: Workflow,
  claims: OutputUnlockClaims,
  position: number
): OutputUnlockPlan {
  const { snapshot, output } = outputAt(workflow, blockOutputCeilingFromClaims(claims), position);
  if (!output) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `output ${position} does not exist` });
  }
  if (isUnrestrictedOutput(output)) return { kind: 'not-restricted', position, snapshot };
  if ('pending' in output) {
    return { kind: 'unavailable', position, message: pendingOutputMessage(position) };
  }
  if ('blocked' in output) {
    return { kind: 'unavailable', position, message: OUTPUT_UNLOCK_BLOCKED_MESSAGE };
  }
  if (output.reason === 'pool') {
    const list = (workflow.transactions as { list?: unknown } | null | undefined)?.list;
    return {
      kind: 'pay',
      position,
      unlockBuzz: unlockPriceFromTransactions(Array.isArray(list) ? list : []),
      snapshot,
    };
  }

  // 'ceiling' and 'unrated' (and any reason added later): never charged. Would the DOMAIN alone,
  // with the viewer's own level out of the way, show it? Then the viewer's settings cut it, and
  // civitai.red would not help.
  const domainOnly: BlockOutputCeiling = {
    maxBrowsingLevel: resolveViewerBrowsingLevel({
      maxBrowsingLevel: claims.maxBrowsingLevel,
      viewerBrowsingLevel: allBrowsingLevelsFlag,
    }),
  };
  if (viewable(outputAt(workflow, domainOnly, position).output)) {
    return { kind: 'unavailable', position, message: OUTPUT_UNLOCK_SETTINGS_MESSAGE };
  }
  // The domain keeps it out. Link out only where civitai.red could show it at all (a workflow cap
  // or a moderation verdict holds everywhere).
  if (viewable(outputAt(workflow, ALL_RATINGS_CEILING, position).output)) {
    return { kind: 'link-out', position, message: OUTPUT_UNLOCK_LINK_OUT_MESSAGE };
  }
  return { kind: 'unavailable', position, message: OUTPUT_UNLOCK_CANNOT_SHOW_MESSAGE };
}

/** A per-viewer daily-limit reservation, taken before the orchestrator is asked. */
export type OutputUnlockReservation =
  | { refused: string; errorCode?: string }
  | { refund: (amount: number) => Promise<void> };

/**
 * Everything the unlock needs from the outside world, bound by the caller to the verified viewer,
 * app and workflow. Injected so each guard below is testable on its own.
 */
export type OutputUnlockDeps = {
  /** The viewer's own orchestrator read of the workflow (their token, so another's 404s). */
  readWorkflow: () => Promise<Workflow>;
  /** `assertUnlockAllowed`: the site-level refusal (green domain, mature content off). */
  assertUnlockAllowed: () => void;
  /** `assertUnlockReleasesOutput`: the orchestrator would release something for the charge. */
  assertUnlockReleasesOutput: () => Promise<void>;
  /** The per-viewer daily limit (and the platform cap), atomically. Refunds itself on refusal. */
  reserveSpend: (cost: number) => Promise<OutputUnlockReservation>;
  /** `updateWorkflow({ allowMatureContent: true })`, bounded. Throws on a refused update. */
  liftRestriction: () => Promise<void>;
  /** The per-workflow lock; `null` when another unlock holds it. */
  acquireLock: () => Promise<(() => Promise<void>) | null>;
};

export type OutputUnlockRequest = {
  workflowId: string;
  position: number;
  viewerUserId: number;
  claims: OutputUnlockClaims;
};

export type OutputUnlockPreview =
  | { kind: 'pay'; position: number; unlockBuzz: number }
  | Exclude<OutputUnlockPlan, { kind: 'pay' } | { kind: 'not-restricted' }>
  | { kind: 'not-restricted'; position: number };

/** Ownership: minted for this viewer, and tagged for the calling app. */
async function readOwnedWorkflow(request: OutputUnlockRequest, deps: OutputUnlockDeps) {
  const workflow = await deps.readWorkflow();
  assertBlockWorkflowTaggedForApp({ tags: workflow.tags, appId: request.claims.appId });
  return workflow;
}

/** The read-only quote the host's dialog shows. Confers nothing and charges nothing. */
export async function previewBlockOutputUnlock(
  request: OutputUnlockRequest,
  deps: OutputUnlockDeps
): Promise<OutputUnlockPreview> {
  assertBlockWorkflowMintedForViewer({
    workflowId: request.workflowId,
    userId: request.viewerUserId,
  });
  const workflow = await readOwnedWorkflow(request, deps);
  const plan = planBlockOutputUnlock(workflow, request.claims, request.position);
  // The preview is a price, never a channel for output: no snapshot leaves it.
  if (plan.kind === 'not-restricted') return { kind: 'not-restricted', position: plan.position };
  if (plan.kind !== 'pay') return plan;
  return { kind: 'pay', position: plan.position, unlockBuzz: plan.unlockBuzz };
}

export type OutputUnlockResult = {
  /**
   * `unlocked`: the output now carries a url. `not-restricted`: it already did (a retry after a
   * success lands here), nothing was charged. `not-released`: the orchestrator accepted the
   * unlock but the output is still restricted at this token's ceiling; the daily-limit
   * reservation was refunded. `refused`: the viewer's daily limit
   * (or the platform cap) refused the spend before the orchestrator was asked; `message` says
   * which, and `errorCode` marks the per-app daily limit the host can offer to raise.
   */
  outcome: 'unlocked' | 'not-restricted' | 'not-released' | 'refused';
  snapshot: BlockWorkflowSnapshot;
  charged: { unlockBuzz: number };
  message?: string;
  errorCode?: string;
};

const NOTHING_CHARGED = { unlockBuzz: 0 } as const;

/**
 * The confirmed unlock. `expectedTotal` is the price the viewer saw in the host's dialog; a
 * re-priced unlock above it is refused, never charged.
 */
export async function unlockBlockOutput(
  request: OutputUnlockRequest & { expectedTotal: number },
  deps: OutputUnlockDeps
): Promise<OutputUnlockResult> {
  assertBlockWorkflowMintedForViewer({
    workflowId: request.workflowId,
    userId: request.viewerUserId,
  });
  const release = await deps.acquireLock();
  if (!release) {
    throw new TRPCError({ code: 'CONFLICT', message: OUTPUT_UNLOCK_IN_PROGRESS_MESSAGE });
  }
  try {
    const workflow = await readOwnedWorkflow(request, deps);
    const plan = planBlockOutputUnlock(workflow, request.claims, request.position);
    if (plan.kind === 'not-restricted') {
      return { outcome: 'not-restricted', snapshot: plan.snapshot, charged: NOTHING_CHARGED };
    }
    if (plan.kind !== 'pay') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: plan.message });
    }

    const total = plan.unlockBuzz;
    if (total > request.expectedTotal) {
      throw new TRPCError({ code: 'CONFLICT', message: OUTPUT_UNLOCK_PRICE_CHANGED_MESSAGE });
    }
    deps.assertUnlockAllowed();
    await deps.assertUnlockReleasesOutput();

    const reservation = await deps.reserveSpend(total);
    if ('refused' in reservation) {
      return {
        outcome: 'refused',
        snapshot: plan.snapshot,
        charged: NOTHING_CHARGED,
        message: reservation.refused,
        ...(reservation.errorCode ? { errorCode: reservation.errorCode } : {}),
      };
    }

    let after: ReturnType<typeof outputAt>;
    try {
      await deps.liftRestriction();
      after = outputAt(
        await deps.readWorkflow(),
        blockOutputCeilingFromClaims(request.claims),
        request.position
      );
    } catch (error) {
      await reservation.refund(total);
      throw error;
    }

    if (!after.output || !isUnrestrictedOutput(after.output)) {
      await reservation.refund(total);
      return { outcome: 'not-released', snapshot: after.snapshot, charged: NOTHING_CHARGED };
    }

    return { outcome: 'unlocked', snapshot: after.snapshot, charged: { unlockBuzz: total } };
  } finally {
    await release();
  }
}
