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
import {
  projectAppWorkflowWithPositions,
  snapshotFromWorkflow,
} from '~/server/services/blocks/workflow.service';
import type { BlockOutputView } from '~/server/services/blocks/block-output-mint';
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
 * The money path ({@link unlockBlockOutput}) runs under a per-workflow lock and re-classifies the
 * workflow at the token's ceiling afterwards.
 *
 * NET ZERO AGAINST EVERY LIMIT (operator decision). An unlock reserves nothing against the
 * viewer's per-app daily limit, the app's aggregate cap or the platform cap: the original
 * generation's spend already counted, and the orchestrator's swap refunds the Blue and charges
 * the same amount in Yellow. The only funds check is the orchestrator's own Yellow balance; its
 * refusal comes back as `refused`.
 *
 * NO AUTHOR SHARE ON AN UNLOCK (operator decision). The only charge is the orchestrator's yellow
 * swap. A generation whose spend accrued an author fee already paid the author once; one whose
 * spend took no fee has none to repeat. So nothing here reaches `chargeBlockAuthorFee`.
 */

/** How long a single unlock may hold its workflow's lock. */
export const OUTPUT_UNLOCK_LOCK_TTL_SECONDS = 300;

/**
 * The bound on the orchestrator write that lifts the restriction. Every other orchestrator call
 * under the lock is a read bounded by `ORCHESTRATOR_GET_TIMEOUT_MS` (`workflows.ts`); there are
 * three (the plan, the release check, the re-classify), so the lock's TTL must exceed this plus
 * three of those. Pinned in the tests against the real read timeout.
 */
export const OUTPUT_UNLOCK_ORCHESTRATOR_TIMEOUT_MS = 30_000;

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
/**
 * Why a paid unlock still withholds the output: the orchestrator accepted it (its yellow swap
 * stands, operator decision), but the read-back is rated above the viewer's ceiling.
 */
export const OUTPUT_UNLOCK_NOT_RELEASED_MESSAGE =
  'The unlock went through, but this output is rated above your browsing level, so it stays hidden.';

/** The unlock was charged, but reading the result back failed. */
export const OUTPUT_UNLOCK_READ_BACK_FAILED_MESSAGE =
  "The unlock went through, but we couldn't load the output. Check again in a few minutes.";

/**
 * The write got no response (our timeout): it may still land. Not retryable from here: the
 * workflow's lock is KEPT until its TTL, so a retry is refused as in progress until then.
 */
export const OUTPUT_UNLOCK_MAY_BE_PENDING_MESSAGE =
  'Your unlock may still be going through. Check again in a few minutes.';

/** No price could be worked out from the workflow's transactions, so nothing is offered. */
export const OUTPUT_UNLOCK_NO_PRICE_MESSAGE =
  "We couldn't work out the price for this unlock. Try again shortly.";

/** The orchestrator refused the yellow charge: the viewer's Yellow balance is short. */
export const OUTPUT_UNLOCK_INSUFFICIENT_FUNDS_MESSAGE =
  'You do not have enough yellow Buzz to unlock this output.';
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
 * The output at `position` as the unlock DECIDES on it (never minted), and the snapshot the
 * app is SHOWN (minted when `view.mint` is set). Deciding on the unminted output keeps a
 * host-side mint failure from reading as "not released" after a paid lift, and lets a retry
 * see the released output and mint again with no second charge. Only the token's own
 * ceiling ever reaches the app; the domain-only and all-ratings calls in
 * {@link planBlockOutputUnlock} decide where to send the viewer and are then discarded.
 */
function outputAt(
  workflow: Workflow,
  ceiling: BlockOutputCeiling,
  position: number,
  view: OutputUnlockView = NO_SERVING
): { snapshot: BlockWorkflowSnapshot; output: BlockWorkflowOutput | undefined } {
  const rules = { ...ceiling, serving: view.serving, servingUnknown: view.servingUnknown };
  const decided = snapshotAt(workflow, { ...rules, mint: null });
  const shown = view.mint ? snapshotAt(workflow, { ...rules, mint: view.mint }) : decided;
  return { snapshot: shown, output: decided.outputs?.[position] };
}

/** The ONE call into `snapshotFromWorkflow` in this module (ledgered in
 * `block-output-restriction.producer-ledger.test.ts`). */
function snapshotAt(workflow: Workflow, view: BlockOutputView): BlockWorkflowSnapshot {
  return snapshotFromWorkflow(workflow, view);
}

/** `resolveBlockOutputView(claims)` without its ceiling: the serving rules and mint. */
export type OutputUnlockView = Pick<
  BlockOutputView,
  'serving' | 'servingUnknown' | 'anonymous' | 'mint'
>;
const NO_SERVING: OutputUnlockView = { serving: false, mint: null };

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
  position: number,
  view: OutputUnlockView
): OutputUnlockPlan {
  const { snapshot, output } = outputAt(
    workflow,
    blockOutputCeilingFromClaims(claims),
    position,
    view
  );
  if (!output) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `output ${position} does not exist` });
  }
  // No serve decision, or a viewer judged as signed out: nothing is offered for pay.
  if (view.servingUnknown || view.anonymous) {
    return { kind: 'unavailable', position, message: OUTPUT_UNLOCK_CANNOT_SHOW_MESSAGE };
  }
  if (isUnrestrictedOutput(output)) return { kind: 'not-restricted', position, snapshot };
  if ('pending' in output) {
    return { kind: 'unavailable', position, message: pendingOutputMessage(position) };
  }
  if ('blocked' in output) {
    return { kind: 'unavailable', position, message: OUTPUT_UNLOCK_BLOCKED_MESSAGE };
  }
  if (output.reason === 'pool') {
    // With serving on, the lifted output must itself be usable: a never-rated engine's video or
    // an `na` output is restricted the moment it is released, so it is never offered for pay.
    if (view.serving) {
      const lifted = outputAt(
        { ...workflow, allowMatureContent: true },
        blockOutputCeilingFromClaims(claims),
        position,
        { serving: true, mint: null }
      ).output;
      if (!lifted || !isUnrestrictedOutput(lifted)) {
        return { kind: 'unavailable', position, message: OUTPUT_UNLOCK_CANNOT_SHOW_MESSAGE };
      }
    }
    const list = (workflow.transactions as { list?: unknown } | null | undefined)?.list;
    const unlockBuzz = unlockPriceFromTransactions(Array.isArray(list) ? list : []);
    // No transactions, or nothing non-yellow to swap: there is no price to show the viewer, and a
    // zero "price" would let the confirm through at whatever the orchestrator then charges.
    if (!(unlockBuzz > 0)) {
      return { kind: 'unavailable', position, message: OUTPUT_UNLOCK_NO_PRICE_MESSAGE };
    }
    return { kind: 'pay', position, unlockBuzz, snapshot };
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
  /**
   * `allowMatureContent: true` at the orchestrator, bounded (`liftWorkflowMatureRestriction`).
   * The orchestrator's Yellow balance check (its 403) is `insufficient-funds`; no response at
   * all (our timeout) is `no-response`, the write possibly still in flight; any other failure
   * throws.
   */
  liftRestriction: () => Promise<{ outcome: 'lifted' | 'insufficient-funds' | 'no-response' }>;
  /** The per-workflow lock; `null` when another unlock holds it. */
  acquireLock: () => Promise<(() => Promise<void>) | null>;
  /**
   * A WARN for support: the lift charged, and the output was not released. Never an error
   * path; the reply already reports the charge.
   */
  warnChargedNotReleased: (entry: ChargedNotReleased) => void;
};

/** One charged-but-not-released unlock, as `warnChargedNotReleased` records it. */
export type ChargedNotReleased = {
  userId: number;
  workflowId: string;
  position: number;
  unlockBuzz: number;
  /** The output's browsing level when the unlock was planned, and after the lift. */
  plannedLevel: number | null;
  servedLevel: number | null;
  /** The read-back after the lift failed, so whether the output was released is unknown. */
  readBackFailed: boolean;
};

export type OutputUnlockRequest = {
  workflowId: string;
  position: number;
  viewerUserId: number;
  claims: OutputUnlockClaims;
  /** From `resolveBlockOutputView(claims)`: `{ serving: false, mint: null }` while off. */
  view: OutputUnlockView;
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
  const plan = planBlockOutputUnlock(workflow, request.claims, request.position, request.view);
  // The preview is a price, never a channel for output: no snapshot leaves it.
  if (plan.kind === 'not-restricted') return { kind: 'not-restricted', position: plan.position };
  if (plan.kind !== 'pay') return plan;
  return { kind: 'pay', position: plan.position, unlockBuzz: plan.unlockBuzz };
}

export type OutputUnlockResult = {
  /**
   * `unlocked`: the output now carries a url. `not-restricted`: it already did (a retry after a
   * success lands here), nothing was charged. `not-released`: the orchestrator accepted the
   * unlock (its swap stands) but the output is still restricted at this token's ceiling, or
   * reading it back after the charge failed; `message` says which. `refused`: the orchestrator refused the yellow charge (the viewer's
   * Yellow balance is short); `message` says so. `unavailable`: the write got no response, so it
   * may still land; the lock is kept until its TTL and `message` says to check back.
   */
  outcome: 'unlocked' | 'not-restricted' | 'not-released' | 'refused' | 'unavailable';
  snapshot: BlockWorkflowSnapshot;
  charged: { unlockBuzz: number };
  message?: string;
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
  // Kept (not released) when the orchestrator write may still be in flight: see `no-response`.
  let keepLock = false;
  try {
    const workflow = await readOwnedWorkflow(request, deps);
    const plan = planBlockOutputUnlock(workflow, request.claims, request.position, request.view);
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

    // Re-plan on a fresh read immediately before the charge: a rescan since the first read must
    // not be charged for.
    const fresh = await deps.readWorkflow();
    const replan = planBlockOutputUnlock(fresh, request.claims, request.position, request.view);
    if (replan.kind === 'not-restricted') {
      return { outcome: 'not-restricted', snapshot: replan.snapshot, charged: NOTHING_CHARGED };
    }
    if (replan.kind !== 'pay') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: replan.message });
    }
    if (replan.unlockBuzz !== total) {
      throw new TRPCError({ code: 'CONFLICT', message: OUTPUT_UNLOCK_PRICE_CHANGED_MESSAGE });
    }

    const lifted = await deps.liftRestriction();
    if (lifted.outcome === 'no-response') {
      keepLock = true;
      return {
        outcome: 'unavailable',
        snapshot: plan.snapshot,
        charged: NOTHING_CHARGED,
        message: OUTPUT_UNLOCK_MAY_BE_PENDING_MESSAGE,
      };
    }
    if (lifted.outcome === 'insufficient-funds') {
      return {
        outcome: 'refused',
        snapshot: plan.snapshot,
        charged: NOTHING_CHARGED,
        message: OUTPUT_UNLOCK_INSUFFICIENT_FUNDS_MESSAGE,
      };
    }
    const charged = { unlockBuzz: total };
    // A failed read-back must not turn a taken charge into an error with no charge reported.
    let afterWorkflow: Workflow | null = null;
    let after: ReturnType<typeof outputAt> | null = null;
    try {
      afterWorkflow = await deps.readWorkflow();
      after = outputAt(
        afterWorkflow,
        blockOutputCeilingFromClaims(request.claims),
        request.position,
        request.view
      );
    } catch {
      after = null;
    }

    if (!after?.output || !isUnrestrictedOutput(after.output)) {
      deps.warnChargedNotReleased({
        userId: request.viewerUserId,
        workflowId: request.workflowId,
        position: request.position,
        unlockBuzz: total,
        plannedLevel: levelAt(fresh, request.position),
        servedLevel: afterWorkflow ? levelAt(afterWorkflow, request.position) : null,
        readBackFailed: after === null,
      });
      return {
        outcome: 'not-released',
        snapshot: after?.snapshot ?? replan.snapshot,
        charged,
        message: after
          ? OUTPUT_UNLOCK_NOT_RELEASED_MESSAGE
          : OUTPUT_UNLOCK_READ_BACK_FAILED_MESSAGE,
      };
    }

    return { outcome: 'unlocked', snapshot: after.snapshot, charged };
  } finally {
    if (!keepLock) await release();
  }
}

/** The browsing level the orchestrator reports for the output at `position`; never sent to the app. */
function levelAt(workflow: Workflow, position: number): number | null {
  try {
    const { positions } = projectAppWorkflowWithPositions(workflow, {
      maxBrowsingLevel: allBrowsingLevelsFlag,
      serving: false,
      mint: null,
    });
    return positions[position]?.image.nsfwLevel ?? null;
  } catch {
    // Feeds a WARN only; a projection failure must not cost the viewer the charge report.
    return null;
  }
}
