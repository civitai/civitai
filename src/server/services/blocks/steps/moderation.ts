import { TRPCError } from '@trpc/server';
import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import {
  isModerationPostureImplemented,
  STEP_MODERATION_POSTURES,
  type AnyBlockStep,
  type StepModerationPosture,
} from './index';

// ─────────────────────────────────────────────────────────────────────────────
// MODERATION DISPATCH for the App Blocks step-type registry (`kind: 'step'`).
//
// 🔴 WHY THIS IS A SEPARATE MODULE FROM `./index`. Same reason `./output` is:
// `index.ts` is imported by `workflow.schema` for the wire enum, and the wire
// schema must stay import-light. `auditPromptServer` drags in Redis, ClickHouse,
// the DB client and the notification service. Keeping the dispatch here means
// declaring a posture costs the schema nothing, and only the ROUTER — which
// already imports all of that — pays for the handler.
//
// 🔴 WHY THE AUDIT RUNS HERE AND NOT IN THE BLOCK. A block is untrusted,
// sandboxed, third-party code. It can decline to call an audit, or call it and
// ignore the verdict, and `extModeration.moderatePrompt` being fail-soft does
// not make the call optional — fail-soft describes what happens when the
// moderation SERVICE is unavailable, not who is allowed to skip it. An audit the
// caller can skip is not a control. This mirrors the rule the block-token mint
// already states for maturity: the host derives the constraint from a claim IT
// minted and never from anything the block sends
// (`src/pages/api/v1/block-tokens/index.ts`).
//
// So the handler runs SERVER-SIDE, in the step submit path, BEFORE the
// orchestrator quote and before any spend reservation — the same position
// `textToImage` (`blocks.router.ts`, the txt2img submit branch) and
// `customComfy` (`submitCustomComfyWorkflow`) already put their audit in.
//
// 🔴 FAIL-SOFT SEMANTICS ARE `auditPromptServer`'s, NOT OURS. It already
// swallows an `extModeration` outage internally (`.catch(… flagged: false)`) and
// throws a BAD_REQUEST when a prompt is actually flagged. This module adds NO
// try/catch around it: wrapping one would turn a flagged prompt into a silent
// pass, and matching the existing kinds exactly is the requirement.
// ─────────────────────────────────────────────────────────────────────────────

export type StepModerationRequest = {
  /** The registry entry being submitted. */
  step: AnyBlockStep;
  /** Params ALREADY parsed by the entry's own `.strict()` schema. */
  params: unknown;
  /** The token subject. */
  userId: number;
  /**
   * 🔴 The prompt audit's SFW toggle. MUST come from `resolveBlockMaturity(claims)`
   * — the token's server-minted `maxBrowsingLevel` ceiling, the same source
   * `allowMatureContent` is derived from — never from a request body field and
   * never a constant. A SFW-domain (green/blue) block therefore gets the stricter
   * audit even if its own code asks otherwise.
   */
  isGreen: boolean;
  /**
   * Lazily resolves the viewer's moderator flag.
   *
   * A THUNK on purpose. The `'none'` path deliberately makes no
   * `getUserById` call per submit (it had nothing to read), and a posture that
   * does not audit must not silently re-add that round-trip. Only a handler that
   * needs the flag pays for it, and the router keeps no per-posture branch.
   */
  loadIsModerator: () => Promise<boolean>;
};

type StepModerationHandler = (req: StepModerationRequest) => Promise<void>;

/**
 * The posture → handler table. TOTAL over `StepModerationPosture`; `null` means
 * "declared, deliberately not implemented", which is a fail-closed gate rather
 * than a missing key that would read as `undefined` at runtime.
 */
const moderationPostureHandlers: Record<StepModerationPosture, StepModerationHandler | null> = {
  // Nothing to run, by construction: no free-text input, no free-text output.
  none: async () => {
    /* no surface */
  },

  /**
   * The posture `textToImage` and `customComfy` already implement inline. Same
   * function, same two text fields, same `isGreen` source, same fail-closed
   * throw — declared by a step instead of hardcoded in a router branch.
   */
  promptAudit: async ({ step, params, userId, isGreen, loadIsModerator }) => {
    const text = step.auditableText?.(params);

    // 🔴 FAIL CLOSED ON "NOTHING TO AUDIT", per request.
    //
    // `auditPromptServer` RETURNS EARLY on an empty prompt. Passing it one would
    // therefore be a declared moderation posture that runs, audits nothing, and
    // reports success — indistinguishable from a clean audit at every call site.
    // The registry's load-time probe proves the entry produces text for its
    // CANONICAL params; this proves it for the params actually submitted, which
    // is the only input an untrusted iframe controls.
    if (typeof text?.prompt !== 'string' || text.prompt.trim().length === 0) {
      throwBadRequestError(
        `step '${step.id}' declares moderation posture '${step.moderationPosture}' but the ` +
          'submitted params carry no auditable text — the request is rejected rather than ' +
          'submitted unaudited'
      );
      return; // unreachable; `throwBadRequestError` throws. Narrows `text` below.
    }

    await auditPromptServer({
      prompt: text.prompt,
      negativePrompt: text.negativePrompt,
      userId,
      isGreen,
      isModerator: await loadIsModerator(),
    });
  },

  // Free-text OUTPUT. Generated text is scanned by nothing on any current path,
  // and answering that is a content-policy decision, not a code one.
  textOutput: null,
};

/**
 * Cross-check that the handler table agrees with `isModerationPostureImplemented`
 * for every declared posture.
 *
 * 🔴 WHY THIS EXISTS. `isModerationPostureImplemented` is what the registry's
 * LOAD-TIME gate reads, and this table is what the REQUEST path reads. If they
 * disagreed in one direction an entry would register cleanly and then have no
 * handler at submit (a 500 on a spend path); in the other, a posture would be
 * unregisterable while its handler sat there working. Asserted at module load so
 * the drift is a build failure, not a Friday surprise.
 *
 * Exported over an arbitrary table so a test can mutation-prove it rather than
 * only observing that the shipped one happens to pass.
 */
export function assertModerationHandlerTable(
  table: Record<StepModerationPosture, StepModerationHandler | null>
): void {
  for (const posture of STEP_MODERATION_POSTURES) {
    const hasHandler = table[posture] != null;
    if (hasHandler !== isModerationPostureImplemented(posture)) {
      throw new Error(
        `block step moderation: posture '${posture}' is declared ` +
          `${isModerationPostureImplemented(posture) ? 'IMPLEMENTED' : 'UNIMPLEMENTED'} but its ` +
          `handler is ${hasHandler ? 'present' : 'absent'} — the registry's load-time gate and ` +
          'the request path would disagree'
      );
    }
  }
}

assertModerationHandlerTable(moderationPostureHandlers);

/**
 * Run the declared moderation posture for a step submit.
 *
 * Throws (TRPCError) to reject; returns normally to allow. Called by
 * `submitStepWorkflow` BEFORE the orchestrator quote and before every spend
 * reservation, so a rejection costs no orchestrator call and has nothing to
 * refund.
 */
export async function runStepModeration(req: StepModerationRequest): Promise<void> {
  const handler = moderationPostureHandlers[req.step.moderationPosture];
  if (!handler) {
    // Defense in depth: the registry's load-time gate already rejects an entry
    // whose posture has no handler, so this is unreachable for a registered
    // step. Kept — and kept fail-closed — because this is the seam a policy
    // mistake would arrive through.
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `step '${req.step.id}' declares an unimplemented moderation posture`,
    });
  }
  await handler(req);
}
