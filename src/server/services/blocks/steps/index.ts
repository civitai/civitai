import type * as z from 'zod';
import { convertImageStep } from './convert-image.step';

// ─────────────────────────────────────────────────────────────────────────────
// App Blocks STEP-TYPE registry (`kind: 'step'`) — RFC #3515 migration step 1.
//
// WHAT THIS IS. A generalization of the `customComfy` recipe registry
// (`~/server/services/blocks/recipes`) from "Comfy recipes" to "orchestrator
// step types". A registered step bundles a stable id, a bounded `.strict()`
// param schema, a pure builder onto an orchestrator step template, a DECLARED
// BILLING MODE, and a DECLARED MODERATION POSTURE.
//
// The block schema's `step` enum is DERIVED from this registry's keys
// (`REGISTERED_STEP_IDS`), so an unregistered id fails closed at the WIRE
// schema — before any translator, any spend reservation, or any orchestrator
// call. Adding a capability is one small reviewed civitai PR: write a
// `<name>.step.ts`, register it below, add tests. The `kind` (`step`) and the
// router are untouched.
//
// 🔴 THE REGISTRY IS A CODE-REVIEWED, NON-DB-EDITABLE TRUST ROOT. Exactly the
// posture the recipe registry has, and it must not change. This module has no
// DB access and loads at import time, before any request context.
//
// 🔴 THIS IS ON THE SPEND PATH. A change here changes what a block can spend.
// Treat every edit as a spend-safety review, not a content edit.
//
// WHAT THIS IS NOT (deliberately, per the RFC):
//   - It does NOT absorb `kind: 'textToImage'`. That member carries entitlement
//     gating over the checkpoint AND the LoRA stack, availability gates,
//     model-token binding, the page-only `sourceImage` rule, `accountType`
//     currency ordering, `sharedContentKey` attribution, and POI handling.
//     Two kinds — a rich first-class generation path plus a uniform registry
//     for everything else — is the honest split.
//   - It does NOT absorb `kind: 'customComfy'`. Migrating that member behind
//     this registry (with `kind: 'customComfy'` retained as a deprecated alias)
//     is the RFC's migration step 3 and is deliberately OUT OF SCOPE here.
//     Step 1 is "land the registry alongside the existing members; nothing
//     breaks."
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Billing mode — "the one field the current interface is missing" (RFC).
//
// `BlockRecipe.budgetFor` encodes `maxBuzz === ceil(stepTimeoutSeconds × 1)`,
// which is elegant *because* it is time-bounded: the aggressive step timeout is
// the physical cap at ~1 Buzz/GPU-second. That invariant does not generalize to
// every step type, so the mode is declared per entry and the money path
// DISPATCHES ON IT.
//
// 🔴 ALL THREE VALUES ARE DEFINED NOW even though the registry only uses
// `prepaidFixed` today. That is the point: the wire contract and the type
// surface are the expensive things to change once `@civitai/app-sdk` mirrors
// them, so future step types must be ADDITIVE (register an entry) rather than a
// schema change. A mode with no registered entry has no money-path handler yet
// and FAILS AT REGISTRY LOAD (see `assertStepInvariants`) — it can never
// silently ride another mode's reservation logic.
// ─────────────────────────────────────────────────────────────────────────────
export type StepBillingMode =
  /** GPU work with variable duration; the step timeout is the physical cap. */
  | 'timeBounded'
  /** Deterministic cost, exactly knowable before execution. */
  | 'prepaidFixed'
  /** Cost scales with tokens, not wall-clock. */
  | 'tokenMetered';

export const STEP_BILLING_MODES: readonly StepBillingMode[] = [
  'timeBounded',
  'prepaidFixed',
  'tokenMetered',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Moderation posture — REQUIRED, and required for a reason.
//
// `BlockRecipe.negativePrompt` exists so the prompt-audit re-point has
// something to read. That hook does not generalize: a step with no prompt
// (image conversion) has no such surface, and a step with a TEXT OUTPUT
// (`chatCompletion`, `mediaCaptioning`, `audioCaptioning`, `transcription`) has
// a NEW one that the prompt audit does not cover at all.
//
// 🔴 MAKING THIS FIELD REQUIRED IS THE WHOLE MECHANISM. Registering a
// text-producing step later is impossible without someone explicitly answering
// the policy question in code — it cannot be quietly skipped, because a posture
// with no implemented handler fails at registry LOAD (a build-time error), not
// at request time on a Friday. That policy decision is deliberately NOT made
// here.
// ─────────────────────────────────────────────────────────────────────────────
export type StepModerationPosture =
  /**
   * No free-text input and no free-text output — the step introduces no new
   * moderation surface. The ONLY posture with an implemented handler today.
   */
  | 'none'
  /**
   * Free-text INPUT that must go through the existing server prompt audit
   * (`auditPromptServer`), as `textToImage` / `customComfy` do.
   * NOT IMPLEMENTED — registering an entry with this posture fails at load.
   */
  | 'promptAudit'
  /**
   * Free-text OUTPUT — a moderation surface the prompt audit does not cover.
   * NOT IMPLEMENTED — registering an entry with this posture fails at load.
   */
  | 'textOutput';

export const STEP_MODERATION_POSTURES: readonly StepModerationPosture[] = [
  'none',
  'promptAudit',
  'textOutput',
] as const;

/**
 * The orchestrator step template a step builder emits: the `$type` discriminator
 * plus its bounded `input`. The envelope concerns the router owns (`name`, and
 * the `timeout` a `timeBounded` entry would stamp) are added at submit — keep
 * builders free of them, exactly as `CustomComfyStepInput` is kept free of the
 * customComfy step envelope.
 */
export type OrchestratorStepTemplate = {
  $type: string;
  input: Record<string, unknown>;
};

/**
 * Fields every registered step declares, regardless of billing mode.
 *
 * `P` is the step's bounded param type (inferred from `paramSchema`).
 */
interface BlockStepBase<P> {
  /** Stable id. The wire `step` enum is DERIVED from the registry keys. */
  id: string;
  /** The orchestrator `$type` this step submits as. */
  orchestratorType: string;
  /** 🔴 REQUIRED. Drives estimate/submit/settle dispatch. */
  billingMode: StepBillingMode;
  /** 🔴 REQUIRED. See `StepModerationPosture`. */
  moderationPosture: StepModerationPosture;
  /**
   * Bounded param schema. MUST be `.strict()` — an unknown param is REJECTED,
   * never silently dropped. Enforced behaviourally at registry load.
   *
   * 🔴 This is not a style preference. `blockTextToImageBodySchema` is NOT
   * `.strict()`, and that non-strictness is exactly what let an older host
   * silently strip `sourceImages` and bill the wrong generation. A dropped
   * param on a money path is a wrong-generation bug, not a validation nit.
   */
  paramSchema: z.ZodType<P>;
  /**
   * The variants this step exposes — the generalization of `BlockRecipe.engines`
   * ("which variant did this resolve to?", an open question in the RFC). Every
   * billing mode keys its price/budget off a variant, which is what lets the
   * load-time invariant loop enumerate the population WITHOUT constructing full
   * params (the same reason `budgetForEngine` exists on `BlockRecipe`).
   */
  variants: readonly string[];
  /**
   * The SINGLE source of truth for "which variant did this submit resolve to?".
   * The price/budget, the built step, and the display estimate MUST all agree on
   * this one value, so they all derive it here. Returns a bounded id from
   * `variants` — never a client-raw string.
   */
  resolveVariant(params: P): string;
  /**
   * A canonical, schema-valid params object for the given variant.
   *
   * Exists SOLELY for the load-time invariant loop, which must evaluate
   * `estimateBuzz` and the strictness probe — both of which need real params —
   * without a request context. Without it the `prepaidFixed` invariant would
   * degrade to "the declared price is an integer", which cannot catch the
   * failure that actually costs money: an `estimateBuzz` that disagrees with
   * the price the caller is charged.
   */
  canonicalParamsFor(variant: string): P;
  /** PURE builder: bounded params → the orchestrator step template. */
  buildStep(params: P): OrchestratorStepTemplate;
  /** The Buzz figure `estimateWorkflow` shows the block. */
  estimateBuzz(params: P): number;
}

/**
 * Deterministic cost, exactly knowable before execution.
 *
 * 🔴 `prepaidFixed` HAS ITS OWN ENFORCED LOAD-TIME INVARIANT — it is NOT
 * exempted from the registry's structural guard. The `timeBounded` invariant
 * (`maxBuzz === ceil(stepTimeoutSeconds)`) rests on a step timeout being a
 * PHYSICAL cap at ~1 Buzz/GPU-second; a fixed-price step has no such time
 * relationship and cannot satisfy it. If `prepaidFixed` entries merely SKIPPED
 * the check, the guard would still exist but would no longer be reachable for
 * the new class — structurally the worst outcome, because the registry would
 * look guarded while new entries were unguarded. So this mode declares an
 * equivalent invariant, validated at load with the same fail-fast shape:
 *
 *   for every variant v:
 *     priceForVariant(v) is a positive safe integer
 *     estimateBuzz(canonicalParamsFor(v)) === priceForVariant(v)
 *
 * The second clause is the money-relevant one: the price is what gets RESERVED
 * against every cap, and `estimateBuzz` is what the app is SHOWN. A divergence
 * means the block quotes one number and the viewer is charged another.
 */
interface PrepaidFixedStep<P> extends BlockStepBase<P> {
  billingMode: 'prepaidFixed';
  /** The exact Buzz price. Positive integer, constant per variant. */
  priceForVariant(variant: string): number;
}

/**
 * GPU work with variable duration. Carries the `BlockRecipe` invariant verbatim
 * (`maxBuzz === ceil(stepTimeoutSeconds)`) because it rests on the same physics.
 *
 * Declared now so the type surface is stable; NO entry uses it yet, and its
 * money-path handler is not implemented, so registering one fails at load.
 */
interface TimeBoundedStep<P> extends BlockStepBase<P> {
  billingMode: 'timeBounded';
  budgetForVariant(variant: string): { maxBuzz: number; stepTimeoutSeconds: number };
}

/**
 * Cost scales with tokens, not wall-clock — the mode that genuinely does not
 * fit today's model, and the reason to sequence LLM steps last (RFC).
 *
 * Declared now so the type surface is stable; NO entry uses it yet, and its
 * money-path handler is not implemented, so registering one fails at load.
 */
interface TokenMeteredStep<P> extends BlockStepBase<P> {
  billingMode: 'tokenMetered';
  maxBuzzForVariant(variant: string): number;
}

/**
 * A registered step. A DISCRIMINATED UNION on `billingMode`, which is what makes
 * a missing or unknown `billingMode` a COMPILE error rather than a runtime
 * surprise (no union member matches), and what gives each mode its own required
 * price/budget accessor.
 */
export type BlockStep<P = unknown> = PrepaidFixedStep<P> | TimeBoundedStep<P> | TokenMeteredStep<P>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyBlockStep = BlockStep<any>;

// ─────────────────────────────────────────────────────────────────────────────
// Spend planning — the money-path dispatch.
//
// 🔴 estimate / submit / settle dispatch on `billingMode`, NEVER on `kind` and
// never on the step id. The router calls `planStepSpend` / `estimateStepBuzz`
// and reads the returned plan; it contains no per-step and no per-mode branch.
// Adding a capability is register-an-entry; adding a MODE is add-a-handler
// here — neither is router surgery. That is the whole point of the RFC.
// ─────────────────────────────────────────────────────────────────────────────

export type StepSpendPlan = {
  /**
   * The Buzz reserved against EVERY cap (per-user daily, per-app aggregate,
   * dev-session) BEFORE the orchestrator submit, and gated against the token's
   * per-call `buzzBudget`.
   */
  reserveBuzz: number;
  /**
   * True when `reserveBuzz` is a CEILING that a terminal poll/cancel must settle
   * down to the real accrued cost (the post-paid machinery `customComfy` uses).
   *
   * `prepaidFixed` is FALSE: the price is exact and known before execution, so
   * the reservation is final and the post-paid settle machinery is never
   * touched — no settle record is persisted and no terminal refund is owed.
   */
  postPaidSettle: boolean;
  /**
   * The orchestrator step `timeout` to stamp, for modes whose cap IS a timeout.
   * `null` when the mode does not use one (`prepaidFixed`: the price is not a
   * function of wall-clock, so a timeout would be a liveness knob, not a Buzz
   * ceiling, and stamping one here would imply a cap relationship that does not
   * exist).
   */
  stepTimeoutSeconds: number | null;
};

type BillingModeHandler = {
  estimateBuzz(step: AnyBlockStep, params: unknown): number;
  planSpend(step: AnyBlockStep, params: unknown): StepSpendPlan;
};

/**
 * A mode that is DECLARED (so the type + wire surface is stable and future
 * additions are additive) but whose money path is not implemented yet.
 *
 * This is a fail-closed gate, not a placeholder: registering an entry with such
 * a mode is rejected at registry LOAD by `assertStepInvariants`, so these
 * functions are unreachable for any registered step. They exist so that the
 * handler table is TOTAL over `StepBillingMode` — which is what makes the
 * "unimplemented" state a compile-visible, enumerable fact rather than a
 * missing object key that reads as `undefined` at runtime.
 */
function unimplementedMode(mode: StepBillingMode): BillingModeHandler {
  const fail = (): never => {
    throw new Error(
      `billing mode '${mode}' has no money-path handler — implement one in ` +
        'services/blocks/steps before registering a step that declares it'
    );
  };
  return { estimateBuzz: fail, planSpend: fail };
}

const billingModeHandlers: Record<StepBillingMode, BillingModeHandler> = {
  prepaidFixed: {
    estimateBuzz: (step, params) => step.estimateBuzz(params),
    planSpend: (step, params) => {
      const entry = step as PrepaidFixedStep<unknown>;
      return {
        reserveBuzz: entry.priceForVariant(entry.resolveVariant(params)),
        // Exact price → the reservation is final; never touch the post-paid
        // settle machinery.
        postPaidSettle: false,
        stepTimeoutSeconds: null,
      };
    },
  },
  timeBounded: unimplementedMode('timeBounded'),
  tokenMetered: unimplementedMode('tokenMetered'),
};

/** True iff the mode has an implemented money-path handler. */
export function isBillingModeImplemented(mode: StepBillingMode): boolean {
  return mode === 'prepaidFixed';
}

/** The display estimate for a step, dispatched on its declared billing mode. */
export function estimateStepBuzz(step: AnyBlockStep, params: unknown): number {
  return billingModeHandlers[step.billingMode].estimateBuzz(step, params);
}

/** The spend plan for a step submit, dispatched on its declared billing mode. */
export function planStepSpend(step: AnyBlockStep, params: unknown): StepSpendPlan {
  return billingModeHandlers[step.billingMode].planSpend(step, params);
}

// ─────────────────────────────────────────────────────────────────────────────
// Moderation dispatch. Same shape, same reasoning: total over the posture
// union, and every posture without an implemented handler is rejected at load.
// ─────────────────────────────────────────────────────────────────────────────

/** True iff the posture has an implemented handler. */
export function isModerationPostureImplemented(posture: StepModerationPosture): boolean {
  // 'none' is implemented by construction: a step with no free-text input and
  // no free-text output introduces no surface, so there is nothing to run. Both
  // other postures need a real, policy-reviewed implementation.
  return posture === 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// The registry object. Its keys ARE the source of truth for the wire enum.
//
// TRANCHE 1 (RFC migration step 2): deterministic, `prepaidFixed`, no new
// moderation surface. See `convert-image.step.ts` for why that entry qualifies.
//
// 🔴 The RFC named Tranche 1 as "background removal, upscale, convert". Only
// CONVERT made it. Enumerating the orchestrator's real `$type` values from the
// generated `@civitai/client` types found that the other two DO exist —
// `imageBackgroundRemoval` and `imageUpscaler` — but neither is `prepaidFixed`:
//   - `imageBackgroundRemoval`: the client's own doc string says it "builds a
//     ComfyUI graph under the hood and runs it as a comfy job", i.e. GPU work
//     with variable duration. That is `timeBounded`, not a deterministic price.
//   - `imageUpscaler`: also GPU work, AND its `model` field takes an arbitrary
//     AIR URN. An AIR chosen by an untrusted iframe reaches the orchestrator
//     without the generation-graph entitlement belt — the same bypass class the
//     customComfy `resources` array carries — so it needs a resource gate first.
// Both are good Tranche 2 candidates once `timeBounded` has a money-path
// handler. Registering either now would have meant declaring a fixed price for
// something whose cost is not fixed.
//
// Also considered and NOT registered: `mediaHash` passes all four bars
// (standalone `$type` with a consumer-recipe endpoint, deterministic CPU
// hashing, bounded hash-string output, no resources) but has no demonstrated
// developer demand, and every registered id is a permanent public wire
// commitment. Adding it later is one file plus one line here — which is the
// entire point of the registry.
// ─────────────────────────────────────────────────────────────────────────────
const stepRegistry = {
  'convert-image': convertImageStep,
};

export type RegisteredStepId = keyof typeof stepRegistry & string;

/**
 * The registered step ids, DERIVED from the registry keys. Consumed by
 * `workflow.schema`'s `blockStepBodySchema` as the fail-closed `step` enum (an
 * unregistered id is rejected at the union). Typed as a non-empty tuple so
 * `z.enum` accepts it.
 */
export const REGISTERED_STEP_IDS = Object.keys(stepRegistry) as [
  RegisteredStepId,
  ...RegisteredStepId[]
];

/** Resolve a step by id. Returns `undefined` for an unregistered id. */
export function getStep(id: string): AnyBlockStep | undefined {
  return (stepRegistry as Record<string, AnyBlockStep>)[id];
}

/**
 * The registered steps as `[id, step]` pairs.
 *
 * Exported so tests can enumerate the REAL population rather than a hardcoded
 * list — a newly added entry that violates an invariant then fails loudly in
 * CI instead of being silently uncovered.
 */
export function listRegisteredSteps(): [string, AnyBlockStep][] {
  return Object.entries(stepRegistry as Record<string, AnyBlockStep>);
}

// ─────────────────────────────────────────────────────────────────────────────
// LOAD-TIME INVARIANTS (fail-fast at module import, mirroring the recipe
// registry's `maxBuzz === ceil(stepTimeoutSeconds)` loop).
//
// Exported as a function over an arbitrary entry so the tests can (a) run it
// against the real population and (b) mutation-test each clause with a fixture
// that violates exactly one of them. A guard that can only be exercised by
// editing the shipped registry is a guard nobody exercises.
// ─────────────────────────────────────────────────────────────────────────────

/** The key used to probe that a step's `paramSchema` really is `.strict()`. */
export const STRICTNESS_PROBE_KEY = '__unregisteredBlockStepParamProbe__';

export function assertStepInvariants(id: string, step: AnyBlockStep): void {
  const where = `block step '${id}'`;

  // (0) The registry key IS the wire id. A mismatch would mean the enum says one
  // thing and every log/metric/error says another.
  if (step.id !== id) {
    throw new Error(`${where}: registry key must equal step.id (got '${step.id}')`);
  }

  // (1) The declared moderation posture must have an implemented handler. A
  // text-producing step cannot be registered until someone answers the policy
  // question in code.
  if (!isModerationPostureImplemented(step.moderationPosture)) {
    throw new Error(
      `${where}: moderationPosture '${step.moderationPosture}' has no implemented handler — ` +
        'a step with a free-text input or output needs a declared, implemented posture'
    );
  }

  // (2) At least one variant, or nothing below can be enumerated.
  if (step.variants.length === 0) {
    throw new Error(`${where}: must declare at least one variant`);
  }

  for (const variant of step.variants) {
    const vWhere = `${where} variant '${variant}'`;
    const params = step.canonicalParamsFor(variant);

    // (3) The canonical params must PARSE. If they don't, every clause below is
    // testing a value the schema would have rejected.
    const parsed = step.paramSchema.safeParse(params);
    if (!parsed.success) {
      throw new Error(
        `${vWhere}: canonicalParamsFor() must satisfy paramSchema (${parsed.error.message})`
      );
    }

    // (4) `.strict()` — an UNKNOWN param must be REJECTED, not silently dropped.
    // Probed behaviourally rather than by inspecting the zod internals, so it
    // holds for any schema shape that achieves strictness.
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      throw new Error(`${vWhere}: canonicalParamsFor() must return a plain params object`);
    }
    const withUnknown = { ...(params as Record<string, unknown>), [STRICTNESS_PROBE_KEY]: 1 };
    if (step.paramSchema.safeParse(withUnknown).success) {
      throw new Error(
        `${vWhere}: paramSchema must be .strict() — it accepted an unknown param ` +
          `('${STRICTNESS_PROBE_KEY}'), which means an unknown param is silently DROPPED`
      );
    }

    // (5) The canonical params for a variant must RESOLVE to that variant, or
    // the price/budget asserted below is not the one this params object buys.
    const resolved = step.resolveVariant(parsed.data);
    if (resolved !== variant) {
      throw new Error(
        `${vWhere}: canonicalParamsFor() resolves to variant '${resolved}', not '${variant}'`
      );
    }

    // (6) Per-mode budget invariant. Runs BEFORE the implemented-handler gate
    // below, deliberately: if the gate ran first, these branches would be
    // structurally UNREACHABLE for `timeBounded` / `tokenMetered` (the gate
    // rejects every such entry, so their clauses could never execute) and the
    // registry would carry two invariants nothing could ever exercise. Ordered
    // this way, a fixture declaring an unimplemented mode still reaches — and
    // can mutation-prove — its own budget guard.
    switch (step.billingMode) {
      case 'prepaidFixed': {
        const price = step.priceForVariant(variant);
        if (!Number.isSafeInteger(price) || price <= 0) {
          throw new Error(
            `${vWhere}: prepaidFixed price (${price}) must be a positive safe integer — ` +
              'it is the exact amount reserved against every spend cap'
          );
        }
        const estimate = step.estimateBuzz(parsed.data);
        if (estimate !== price) {
          throw new Error(
            `${vWhere}: prepaidFixed estimateBuzz (${estimate}) must equal the declared ` +
              `price (${price}) — the block is SHOWN the estimate and CHARGED the price`
          );
        }
        break;
      }
      case 'timeBounded': {
        const budget = step.budgetForVariant(variant);
        const enforced = Math.ceil(budget.stepTimeoutSeconds);
        if (!Number.isSafeInteger(enforced) || enforced <= 0) {
          throw new Error(
            `${vWhere}: timeBounded stepTimeoutSeconds (${budget.stepTimeoutSeconds}) must be positive`
          );
        }
        if (budget.maxBuzz !== enforced) {
          throw new Error(
            `${vWhere}: timeBounded maxBuzz (${budget.maxBuzz}) must equal ` +
              `ceil(stepTimeoutSeconds) (${enforced}) — the step timeout is the physical Buzz ceiling`
          );
        }
        break;
      }
      case 'tokenMetered': {
        const maxBuzz = step.maxBuzzForVariant(variant);
        if (!Number.isSafeInteger(maxBuzz) || maxBuzz <= 0) {
          throw new Error(
            `${vWhere}: tokenMetered maxBuzz (${maxBuzz}) must be a positive safe integer`
          );
        }
        break;
      }
    }
  }

  // (7) LAST: the declared billing mode must have an implemented money-path
  // handler. This is what stops a newly declared mode from riding another
  // mode's reservation logic — it is a BUILD failure, not a runtime one.
  //
  // Placed last so the structural per-variant invariants above stay reachable
  // (see clause 6). Position does not weaken it: every clause here throws at
  // module load, so an entry declaring an unimplemented mode still cannot
  // register regardless of which guard reports first.
  if (!isBillingModeImplemented(step.billingMode)) {
    throw new Error(
      `${where}: billingMode '${step.billingMode}' has no implemented money-path handler`
    );
  }
}

// Fail-fast every invariant at module load. A registry that violates one is a
// BUILD-time error, not a runtime surprise on a spend path.
for (const [id, step] of listRegisteredSteps()) {
  assertStepInvariants(id, step);
}
