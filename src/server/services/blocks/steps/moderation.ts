import { TRPCError } from '@trpc/server';
import type { Workflow } from '@civitai/client';
import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import {
  getStepByOrchestratorType,
  isModerationPostureImplemented,
  posturePhaseRequirements,
  STEP_MODERATION_POSTURES,
  type AnyBlockStep,
  type StepModerationPosture,
} from './index';
import { screenGeneratedText, TEXT_OUTPUT_WITHHELD_MESSAGE } from './text-output-moderation';

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
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 TWO PHASES, AND THE TABLE IS KEYED BY THEM. READ THIS BEFORE ADDING A
// POSTURE.
//
// The dispatch above runs at SUBMIT, before the orchestrator call. That is the
// right position for `'promptAudit'` — it audits INPUT the caller already sent,
// and a rejection there costs no orchestrator call and has nothing to refund.
//
// It is the WRONG position for an OUTPUT scan, and wrong in the most dangerous
// way available: a `'textOutput'` handler placed here would run before the
// generation exists, scan an empty string, return cleanly, and report success.
// The registry's load-time gate would be satisfied, the posture would be
// "implemented", every test asserting the posture is declared would pass, and
// generated text would reach blocks completely unscanned. A feature that passes
// every check while being inert has shipped in this codebase before.
//
// So the table maps each posture to a PHASE RECORD, and
// `assertModerationHandlerTable` checks it against `posturePhaseRequirements`
// (`./index`) in BOTH directions: a required phase with no handler fails, AND a
// handler in a phase the posture does not require fails. The second direction is
// the one that matters here — it makes "satisfy `'textOutput'` with a submit
// handler" a BUILD failure rather than something a reviewer has to spot.
//
//   SUBMIT — `runStepModeration`, step submit path, pre-quote, pre-reservation.
//   OUTPUT — `runStepOutputModeration`, the READ boundary, post-generation.
//            Reached through `attachModeratedStepTextOutputs`, which is the SOLE
//            producer of a snapshot's `textOutputs` (see that function).
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

/** One completed orchestrator step, to be screened before it is published. */
export type StepOutputModerationRequest = {
  /** The registry entry whose `orchestratorType` matched the step's `$type`. */
  step: AnyBlockStep;
  /** The orchestrator's COMPLETED step object, as returned on the workflow. */
  orchestratorStep: unknown;
  /** The token subject. */
  userId: number;
  /**
   * 🔴 From `resolveBlockMaturity(claims).isGreen` — the token's server-minted
   * maturity ceiling, exactly as the submit phase takes it. It selects the
   * SFW-only tier of the label policy (`NSFW` / `Suggestive` / `Explicit`), so a
   * request-body flag here would let a SFW-domain block license its own mature
   * output. Never a request field.
   */
  isGreen: boolean;
  /** The OauthClient id off the verified block token — the per-app trigger key. */
  appId: string;
  /** The block instance id, when the caller has one. */
  appBlockId?: string;
};

/**
 * The verdict for one step's generated text.
 *
 * 🔴 `texts` IS THE ONLY CHANNEL. The read path publishes exactly what a
 * `released: true` verdict carries and never reads `step.output` itself, so text
 * that did not come back through here cannot reach a block.
 */
export type StepOutputModerationResult =
  | { released: true; texts: string[] }
  | { released: false; reason: string };

type StepOutputModerationHandler = (
  req: StepOutputModerationRequest
) => Promise<StepOutputModerationResult>;

/**
 * A posture's handlers, one slot per phase. `null` means "this posture has no
 * moderation surface in this phase" — which `assertModerationHandlerTable`
 * cross-checks against `posturePhaseRequirements`, so it can never quietly mean
 * "nobody got round to it".
 */
type StepModerationPhases = {
  submit: StepModerationHandler | null;
  output: StepOutputModerationHandler | null;
};

/**
 * The posture → phase-handler table. TOTAL over `StepModerationPosture`.
 *
 * A phase slot of `null` means "no surface in this phase", NOT "unimplemented":
 * `assertModerationHandlerTable` pins every slot against the phases the posture
 * is declared to require, in both directions, so the two readings cannot be
 * confused. A posture whose REQUIRED phase is `null` is what makes it
 * unimplemented, and that is a load-time failure.
 *
 * 🔴 NULL PROTOTYPE, AND THAT IS A CONTROL RATHER THAN A STYLE CHOICE. A plain
 * object literal inherits from `Object.prototype`, so indexing it with an
 * arbitrary string falls through: `handlers['toString']` returns
 * `Object.prototype.toString` — TRUTHY — which makes the `!handler` guard in
 * `runStepModeration` below evaluate `false`, lets `await handler(req)` resolve,
 * and returns from the whole submit path HAVING AUDITED NOTHING AND THROWN
 * NOTHING. The one guard whose job is to fail closed on an unimplemented posture
 * would fail OPEN, for the exact key an attacker would reach for. The registry's
 * load-time gate makes that unreachable for a REGISTERED step today, but this
 * seam exists precisely for the day the posture value stops coming from a
 * code-reviewed literal (a DB column, a manifest field) — and defence in depth
 * that inverts under a chosen input is worse than none. With a null prototype
 * every non-own key reads `undefined` and the guard fails closed. It also covers
 * `assertModerationHandlerTable`, which walks the same table.
 *
 * `satisfies` (in addition to the annotation) is what keeps the literal TOTAL
 * over the posture union — a missing posture is exactly the drift this table
 * exists to make impossible. Verified by typecheck mutation rather than assumed:
 * deleting `textOutput` from the literal WITH `satisfies` present is a `TS1360`
 * build error; deleting `satisfies` as well makes that error disappear, because
 * `Object.assign`'s inferred result type absorbs the shortfall and the
 * annotation alone does not reject it (it also costs the handlers their
 * contextual typing — 5×`TS7031`).
 */
const moderationPostureHandlers: Record<StepModerationPosture, StepModerationPhases> =
  Object.assign(Object.create(null) as Record<StepModerationPosture, StepModerationPhases>, {
    // Nothing to run in EITHER phase, by construction: no free-text input, no
    // free-text output. Both `null`s are load-asserted against
    // `posturePhaseRequirements('none')`, so this is a stated absence of
    // surface rather than an unwritten handler.
    none: { submit: null, output: null },

    /**
     * The posture `textToImage` and `customComfy` already implement inline. Same
     * function, same two text fields, same `isGreen` source, same fail-closed
     * throw — declared by a step instead of hardcoded in a router branch.
     *
     * OUTPUT phase is `null`: this posture covers INPUT. A `'promptAudit'`
     * step's result is media, and media is rated by the orchestrator's own
     * blob `nsfwLevel` on the existing extraction path — not this scan.
     */
    promptAudit: {
      output: null,
      submit: async ({ step, params, userId, isGreen, loadIsModerator }) => {
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

        // 🔴 FAIL CLOSED ON A NON-STRING `negativePrompt`, mirroring the load-time
        // check in `./index` clause 5a on the params actually submitted. Load time
        // proves the shape for CANONICAL params only; an entry carrying a lying
        // `as unknown as string` cast satisfies neither the compiler nor that probe
        // and would otherwise reach the audit unchecked.
        //
        // 🔴 WHY THIS CANNOT BE LEFT TO `auditPromptServer` TO NOTICE. A non-string
        // reaches `stripBenignPhrases` and throws `text.replace is not a function`
        // INSIDE that function's own try block. Its catch treats the throw as a
        // moderation hit: on the non-green path it writes a `BlockedPromptEntry` and
        // increments the auto-mute counter before rethrowing "Your prompt was
        // flagged". So the failure mode is not a 500 a reviewer would notice — it is
        // innocent users accruing mute-counter hits on every submit because of a
        // registry-entry bug.
        if (text.negativePrompt !== undefined && typeof text.negativePrompt !== 'string') {
          throwBadRequestError(
            `step '${step.id}' declares moderation posture '${step.moderationPosture}' but the ` +
              'submitted params produced a non-string negativePrompt — the request is rejected ' +
              'rather than audited with a value auditPromptServer cannot read'
          );
        }

        await auditPromptServer({
          prompt: text.prompt,
          negativePrompt: text.negativePrompt,
          userId,
          isGreen,
          isModerator: await loadIsModerator(),
        });
      },
    },

    /**
     * Free-text OUTPUT — scanned at the READ boundary, never at submit.
     *
     * SUBMIT phase is `null` and that is load-asserted, not incidental: a
     * submit-phase handler for this posture would necessarily scan nothing
     * (the generation has not run) while satisfying every gate.
     */
    textOutput: {
      submit: null,
      output: async ({ step, orchestratorStep, userId, isGreen, appId, appBlockId }) => {
        const texts = step.extractText?.(orchestratorStep);

        // 🔴 FAIL CLOSED ON A MISSING / UNUSABLE EXTRACTOR AT REQUEST TIME.
        // Registry clause 1c rejects an entry with no `extractText`, and
        // clause 8a rejects one that returns nothing for its canonical
        // output — but both probe a CANONICAL sample, so an extractor that
        // returns a non-array or a non-string entry for a REAL response
        // reaches here. Withholding is the only safe answer: the alternative
        // is to publish whatever partial value we could coerce, which is
        // publishing text the scan never saw.
        if (!Array.isArray(texts) || texts.some((t) => typeof t !== 'string')) {
          return { released: false, reason: TEXT_OUTPUT_WITHHELD_MESSAGE };
        }

        return await screenGeneratedText({
          texts,
          userId,
          isGreen,
          appId,
          appBlockId,
          stepId: step.id,
          model: step.orchestratorType,
        });
      },
    },
  } satisfies Record<StepModerationPosture, StepModerationPhases>);

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
  table: Record<StepModerationPosture, StepModerationPhases>
): void {
  for (const posture of STEP_MODERATION_POSTURES) {
    const phases = table[posture];
    if (!phases) {
      throw new Error(
        `block step moderation: posture '${posture}' has no phase entry — the request path would ` +
          'read undefined for a declared posture'
      );
    }
    const required = posturePhaseRequirements(posture);

    // 🔴 DIRECTION ONE: a handler in a phase the posture does not require.
    //
    // THIS IS THE CLAUSE THAT MAKES THE POSTURE UN-FAKEABLE, and it is the one
    // to leave alone. `'textOutput'` requires the OUTPUT phase; the tempting
    // shape — put the scan in the SUBMIT phase, where every other posture's
    // handler already lives — would run before the generation exists, scan an
    // empty string, and report success. This rejects it at module load. A
    // handler that never runs, or runs where its subject does not yet exist,
    // reads as coverage and is worse than an absent one.
    for (const phase of ['submit', 'output'] as const) {
      if (!required[phase] && phases[phase] != null) {
        throw new Error(
          `block step moderation: posture '${posture}' declares a ${phase}-phase handler, but its ` +
            `moderation surface is not in that phase — a handler that runs where its subject does ` +
            'not exist scans nothing and reports success'
        );
      }
    }

    // 🔴 DIRECTION TWO: the registry's load-time gate and the request path must
    // agree on whether the posture is implemented at all. If they disagreed one
    // way an entry would register cleanly and then have no handler at request
    // time (a 500 on a spend path); the other way, a working posture would be
    // unregisterable.
    const satisfied =
      (!required.submit || phases.submit != null) && (!required.output || phases.output != null);
    if (satisfied !== isModerationPostureImplemented(posture)) {
      const missing = [
        required.submit && phases.submit == null ? 'submit' : null,
        required.output && phases.output == null ? 'output' : null,
      ].filter(Boolean);
      throw new Error(
        `block step moderation: posture '${posture}' is declared ` +
          `${isModerationPostureImplemented(posture) ? 'IMPLEMENTED' : 'UNIMPLEMENTED'} but its ` +
          `required phases are ${
            missing.length ? `MISSING (${missing.join(', ')})` : 'all present'
          } — the registry's load-time gate and the request path would disagree`
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
  const phases = moderationPostureHandlers[req.step.moderationPosture];
  if (!phases) {
    // Defense in depth: the registry's load-time gate already rejects an entry
    // whose posture has no handler, so this is unreachable for a registered
    // step. Kept — and kept fail-closed — because this is the seam a policy
    // mistake would arrive through. The table's NULL PROTOTYPE is what makes an
    // `Object.prototype` key (`'toString'`, `'constructor'`) land here as
    // `undefined` rather than resolving to an inherited method.
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `step '${req.step.id}' declares an unimplemented moderation posture`,
    });
  }
  // A posture that REQUIRES the submit phase but has no handler is rejected at
  // module load, so this branch is unreachable for a declared posture — it is
  // the same defense-in-depth as above, one level finer, and it must throw
  // rather than fall through to "ran nothing, allowed everything".
  const required = posturePhaseRequirements(req.step.moderationPosture);
  if (required.submit && !phases.submit) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `step '${req.step.id}' declares a posture with no submit-phase handler`,
    });
  }
  if (phases.submit) await phases.submit(req);
}

/**
 * Run the declared OUTPUT-phase moderation for one completed orchestrator step.
 *
 * Returns a verdict; does NOT throw to reject. That asymmetry with
 * `runStepModeration` is deliberate: a submit-time rejection is the whole
 * response (nothing has been generated or charged), whereas at read time the
 * caller has already paid and a poll must still return a status, a cost and any
 * media. So a withhold is reported IN the snapshot, not as a failed request.
 *
 * 🔴 FAIL CLOSED ON EVERY UNKNOWN. An unregistered posture, or a posture that
 * requires the output phase but has no handler, WITHHOLDS — it does not fall
 * through to a release. A posture with no output surface at all (`'none'`,
 * `'promptAudit'`) releases an EMPTY list, which publishes nothing.
 */
export async function runStepOutputModeration(
  req: StepOutputModerationRequest
): Promise<StepOutputModerationResult> {
  const posture = req.step.moderationPosture;
  const phases = moderationPostureHandlers[posture];
  if (!phases) return { released: false, reason: TEXT_OUTPUT_WITHHELD_MESSAGE };

  const required = posturePhaseRequirements(posture);
  if (required.output && !phases.output) {
    return { released: false, reason: TEXT_OUTPUT_WITHHELD_MESSAGE };
  }
  // No output surface declared for this posture — nothing to scan and, because
  // the caller publishes only what comes back here, nothing to publish either.
  if (!phases.output) return { released: true, texts: [] };
  return await phases.output(req);
}

/** The snapshot fields this module owns. See `attachModeratedStepTextOutputs`. */
export type ModeratedTextOutputFields = {
  textOutputs?: string[];
  textOutputWithheld?: { reason: string };
};

/**
 * Attach a workflow's SCANNED generated text to a snapshot.
 *
 * 🔴 THIS FUNCTION IS THE SOLE PRODUCER OF `snapshot.textOutputs`. BE EXACT
 * ABOUT WHAT ENFORCES THAT — an earlier revision of this comment said
 * `snapshotFromWorkflow` and `projectAppWorkflow` "read `extractOutput`, which
 * returns MEDIA and cannot carry a string of prose", and that reasoning was
 * WRONG: `StepOutputMedia.url` is a bare `string`, never URL-validated, and it
 * reaches `snapshot.imageUrls` / `AppWorkflow.images[].url` without meeting this
 * function. `extractOutput: () => [{ url: theModelsReply, … }]` would have
 * published unscanned generated text with every gate green. It is recorded here
 * rather than quietly corrected because in a code-reviewed trust root the
 * comment IS the control.
 *
 * WHAT ACTUALLY HOLDS IT, all three off the one `stepOutputShape` predicate:
 *   1. TYPE — `TextOutputSurface.extractOutput?: never`. A `'textOutput'` entry
 *      cannot declare a media extractor.
 *   2. LOAD — registry clause 8-ii rejects the declaration anyway, for the
 *      `as`-cast path a type cannot close.
 *   3. READ — both `workflow.service` extractors call `extractOutput` only when
 *      `postureProducesMedia(entry.moderationPosture)`, so even a cast-in
 *      extractor contributes nothing.
 * Plus the original structural point, which does still stand on its own: a scan
 * is an async network call and both projections are pure and synchronous, so
 * neither could perform one even if it wanted to.
 *
 * The result is that the only route from `step.output` to a block's
 * `textOutputs` runs through the scan below, and the withhold branch simply
 * never writes the field.
 *
 * The incoming snapshot's own text fields are STRIPPED before merging, so a
 * caller that somehow arrived carrying text cannot smuggle it past the scan by
 * pre-populating them. That is cheap, and it is what turns "nothing else sets
 * this field today" into "nothing else CAN".
 *
 * 🔴 PER-STEP, NOT ALL-OR-NOTHING. A workflow with two text steps where one
 * trips the policy publishes the clean one and marks the other withheld. Every
 * string in `textOutputs` has passed a scan either way — that property is what
 * matters, and suppressing clean output because a sibling failed would withhold
 * more than the policy asks for.
 */
export async function attachModeratedStepTextOutputs<T extends ModeratedTextOutputFields>(
  snapshot: T,
  workflow: Workflow,
  ctx: { userId: number; isGreen: boolean; appId: string; appBlockId?: string }
): Promise<T> {
  const {
    textOutputs: _ignoredIncomingTexts,
    textOutputWithheld: _ignoredIncomingWithheld,
    ...rest
  } = snapshot;

  const released: string[] = [];
  let withheldReason: string | undefined;

  for (const step of workflow.steps ?? []) {
    // Only REGISTERED step types have a declared posture. Everything else —
    // textToImage, customComfy, comfy, imageGen — is media-only on this bridge
    // and has no text surface to publish, so there is nothing here to withhold.
    const entry = getStepByOrchestratorType(step.$type);
    if (!entry) continue;
    // 🔴 NO PER-POSTURE BRANCH HERE. The dispatch owns that table; this loop
    // calls it for every registered step and reads the verdict. A `'none'`
    // entry costs one function call and no IO.
    const verdict = await runStepOutputModeration({
      step: entry,
      orchestratorStep: step,
      userId: ctx.userId,
      isGreen: ctx.isGreen,
      appId: ctx.appId,
      appBlockId: ctx.appBlockId,
    });
    if (verdict.released) released.push(...verdict.texts);
    else withheldReason ??= verdict.reason;
  }

  return {
    ...(rest as T),
    ...(released.length > 0 ? { textOutputs: released } : {}),
    ...(withheldReason ? { textOutputWithheld: { reason: withheldReason } } : {}),
  };
}
