/* eslint-disable @typescript-eslint/no-unused-vars --
 * Every declaration in this file is INTENTIONALLY unused at runtime. The
 * assertions are the type aliases themselves: `tsc` evaluates each one while
 * checking the file, and a violated contract fails the build. "Using" them
 * somewhere would add runtime weight and prove nothing extra.
 */
import type * as z from 'zod';
import type { BlockStep } from './index';

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
  paramSchema: ParamSchema;
  variants: readonly string[];
  resolveVariant(params: Params): string;
  canonicalParamsFor(variant: string): Params;
  priceForVariant(variant: string): number;
  estimateBuzz(params: Params): number;
  buildStep(params: Params): { $type: string; input: Record<string, unknown> };
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
