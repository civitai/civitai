/* eslint-disable @typescript-eslint/no-unused-vars --
 * Every declaration in this file is INTENTIONALLY unused at runtime. The
 * assertions are the type aliases themselves: `tsc` evaluates each one while
 * checking the file, and a violated contract fails the build. "Using" them
 * somewhere would add runtime weight and prove nothing extra.
 */
import type { ConvertImageOutput, ConvertImageStep, ImageBlob } from '@civitai/client';
import type * as z from 'zod';
import type { ConvertImageOutputStepLike } from './convert-image.step';
import type { BlockStep } from './index';
import type { OrchestratorBlobLike, StepOutputMedia } from './output';

// ─────────────────────────────────────────────────────────────────────────────
// COMPILE-TIME contract for the step registry: `billingMode` and
// `moderationPosture` are REQUIRED, the mode must be one of the three declared
// values, and each mode must supply its OWN price/budget accessor. Omitting any
// of these is a BUILD failure, not a runtime one.
//
// 🔴 WHY THIS FILE IS NOT UNDER `__tests__/`. `tsconfig.json` EXCLUDES
// `src/**/__tests__/**`, and `pnpm run typecheck` (the blocking CI job) is
// `tsc --noEmit` against that config — so a type-level test placed in
// `__tests__/` is never typechecked by anything. It would sit there looking like
// a guarantee, pass every run, and be incapable of ever failing. (That is
// exactly what the first draft of this file was, and a clean `tsc` run "proving"
// it worked was the tell that it did not.) Vitest does not typecheck either, so
// there is no second mechanism to fall back on. Living here — inside the
// `src` include — is what makes these assertions real.
//
// Everything below is TYPE-ONLY: no values, no exports with runtime
// representation, so this module compiles to nothing and adds no bundle weight.
// ─────────────────────────────────────────────────────────────────────────────

/** Compiles only when `T` is exactly `true`. */
type Expect<T extends true> = T;

/** `true` when `T` is NOT assignable to `U` — i.e. `U` genuinely requires more. */
type NotAssignable<T, U> = [T] extends [U] ? false : true;

type Params = { value: number };
type ParamSchema = z.ZodType<Params>;

/** A complete, well-formed entry. The CONTROL for every negative case below. */
type CompleteStep = {
  id: string;
  orchestratorType: string;
  billingMode: 'prepaidFixed';
  moderationPosture: 'none';
  resourcePolicy: { kind: 'none' };
  paramSchema: ParamSchema;
  variants: readonly string[];
  resolveVariant(params: Params): string;
  canonicalParamsFor(variant: string): Params;
  priceForVariant(variant: string): number;
  estimateBuzz(params: Params): number;
  buildStep(params: Params): { $type: string; input: Record<string, unknown> };
  extractOutput(step: unknown): StepOutputMedia[];
  canonicalOutputFor(variant: string): unknown;
};

// 🔴 THE CONTROL. If this ever stops compiling, every assertion below is
// meaningless — they would all "pass" because the BASE shape is broken, not
// because the field under test is missing.
type _Control = Expect<CompleteStep extends BlockStep<Params> ? true : false>;

// ── `billingMode` is REQUIRED ────────────────────────────────────────────────
// It drives estimate/submit/settle dispatch; an entry without one has no money
// path at all.
type _RequiresBillingMode = Expect<
  NotAssignable<Omit<CompleteStep, 'billingMode'>, BlockStep<Params>>
>;

// ── `moderationPosture` is REQUIRED ──────────────────────────────────────────
// 🔴 This is the mechanism that makes registering a text-producing step
// (`chatCompletion`, captioning, transcription) impossible without someone
// explicitly answering the moderation-policy question in code. If this assertion
// ever fails, the field became optional and that question became skippable.
type _RequiresModerationPosture = Expect<
  NotAssignable<Omit<CompleteStep, 'moderationPosture'>, BlockStep<Params>>
>;

// ── the mode must be one of the three DECLARED values ────────────────────────
type _RejectsUnknownBillingMode = Expect<
  NotAssignable<
    Omit<CompleteStep, 'billingMode'> & { billingMode: 'freeForAll' },
    BlockStep<Params>
  >
>;

// ── each mode must supply its OWN price/budget accessor ──────────────────────
// A `prepaidFixed` entry without `priceForVariant` has nothing to reserve; a
// `timeBounded` one without `budgetForVariant` has no ceiling. The discriminated
// union is what makes both a compile error rather than an `undefined is not a
// function` on the spend path.
type _PrepaidFixedNeedsPrice = Expect<
  NotAssignable<Omit<CompleteStep, 'priceForVariant'>, BlockStep<Params>>
>;

type _TimeBoundedNeedsBudget = Expect<
  NotAssignable<
    Omit<CompleteStep, 'billingMode' | 'priceForVariant'> & { billingMode: 'timeBounded' },
    BlockStep<Params>
  >
>;

type _TokenMeteredNeedsMaxBuzz = Expect<
  NotAssignable<
    Omit<CompleteStep, 'billingMode' | 'priceForVariant'> & { billingMode: 'tokenMetered' },
    BlockStep<Params>
  >
>;

// ── `resourcePolicy` is REQUIRED ─────────────────────────────────────────────
// 🔴 The ENTITLEMENT axis. `BlockRecipe` carried `resourceAllowlist` +
// `checkpointPolicy` and the first draft of this generalization dropped both —
// while the PR's own triage disqualified `imageUpscaler` precisely because its
// arbitrary-AIR `model` field would reach the orchestrator around the
// generation-graph entitlement belt. If this assertion ever fails, the field
// became optional and a future AIR-taking entry can register without declaring
// anything.
type _RequiresResourcePolicy = Expect<
  NotAssignable<Omit<CompleteStep, 'resourcePolicy'>, BlockStep<Params>>
>;

// ── the policy must be one of the DECLARED shapes ────────────────────────────
type _RejectsUnknownResourcePolicy = Expect<
  NotAssignable<
    Omit<CompleteStep, 'resourcePolicy'> & { resourcePolicy: { kind: 'anythingGoes' } },
    BlockStep<Params>
  >
>;

// ── `extractOutput` is REQUIRED ──────────────────────────────────────────────
// 🔴 This is what makes "register a step" and "its result is retrievable" ONE
// action. Without it, both `workflow.service` extractors `continue` past the new
// `$type` and the capability is inert AFTER the caller has been charged — which
// is exactly what shipped. If this assertion ever fails, a new entry can be
// registered with no way to return its output.
type _RequiresExtractOutput = Expect<
  NotAssignable<Omit<CompleteStep, 'extractOutput'>, BlockStep<Params>>
>;

// ── `canonicalOutputFor` is REQUIRED ─────────────────────────────────────────
// The probe input for the load-time extraction invariant. Without it,
// `extractOutput` could be satisfied by `() => []` — compiling, registering, and
// shipping the same inert capability.
type _RequiresCanonicalOutput = Expect<
  NotAssignable<Omit<CompleteStep, 'canonicalOutputFor'>, BlockStep<Params>>
>;

// ─────────────────────────────────────────────────────────────────────────────
// OUTPUT-SHAPE ANCHORING — tie the hand-written read shapes to the GENERATED
// orchestrator contract.
//
// 🔴 WHY, AND WHAT IT DOES *NOT* FIX. The registry's load-time clause 8 probes
// `extractOutput(canonicalOutputFor(v))` — but BOTH sides of that probe are
// authored by the same person in the same file, so it is a SELF-CONSISTENT PAIR,
// not a contract check. It only catches an extractor that surfaces nothing for
// its own sample; it cannot catch an extractor and a sample that agree with each
// other while both being wrong about the orchestrator. Two escapes were
// reproduced: an extractor that ignores its argument paired with
// `canonicalOutputFor: () => ({})`, and an extractor reading `output.images`
// paired with a sample that also encodes `output.images`. Both register cleanly.
//
// The assertions below close that for `convert-image` specifically, by making
// `@civitai/client`'s generated types — which Civitai does not hand-write — the
// authority for the shape the extractor reads.
//
// 🔴 HONEST LIMIT: this does NOT make clause 8 a general guard. A FUTURE entry
// still supplies its own read shape and its own sample, and nothing here forces
// it to add an assertion of its own — the escape stays open for entry #2. What
// is anchored is the one registered entry. Making the anchoring REQUIRED for
// every entry needs a `$type` → generated-step-type mapping the registry can
// consult at the type level; `@civitai/client` exports no discriminated union of
// all step types (only the individual `<Name>Step` aliases), so that map would
// itself be hand-written — which is why it is proposed rather than built here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A REAL `ConvertImageStep` must satisfy the hand-written shape `extractOutput`
 * casts to. This is the assertion that fails if the generated output type ever
 * changes in a way the extractor's read would not survive (a retyped `url`, a
 * `blob` that stops being optional-nullable, and so on).
 */
type _RealConvertImageStepSatisfiesReadShape = Expect<
  ConvertImageStep extends ConvertImageOutputStepLike ? true : false
>;

/**
 * Every key the read shape declares under `output` must EXIST on the generated
 * `ConvertImageOutput`.
 *
 * 🔴 This is the assertion that catches the exact shipped-bug shape (reading
 * `blobs` where the orchestrator returns `blob`). Assignability alone does not:
 * a read shape whose properties are all optional is satisfied by anything, so
 * renaming `blob` → `blobs` would still compile against the assertion above.
 * `keyof` is what makes the key name itself load-bearing.
 */
type _ConvertImageReadKeysExist = Expect<
  keyof NonNullable<ConvertImageOutputStepLike['output']> extends keyof ConvertImageOutput
    ? true
    : false
>;

/** Same, one level down: every blob field the extractor reads is a real `ImageBlob` field. */
type _ConvertImageBlobReadKeysExist = Expect<
  keyof NonNullable<
    NonNullable<ConvertImageOutputStepLike['output']>['blob']
  > extends keyof ImageBlob
    ? true
    : false
>;

/**
 * The SHARED filter's input contract, anchored once for every entry that uses it.
 * `mediaFromBlobs` is the one copy of the availability + non-empty-url rule, and
 * `OrchestratorBlobLike` is the shape it promises to handle — so a real
 * `ImageBlob` must be assignable to it. Unlike the three above, this assertion
 * is not entry-specific: it covers any future entry that feeds a generated blob
 * through `mediaFromBlobs`.
 */
type _MediaFromBlobsAcceptsGeneratedImageBlob = Expect<
  ImageBlob extends OrchestratorBlobLike ? true : false
>;
