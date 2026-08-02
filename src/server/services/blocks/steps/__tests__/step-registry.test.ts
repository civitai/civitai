import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  assertStepInvariants,
  estimateStepBuzz,
  getStep,
  isBillingModeImplemented,
  isModerationPostureImplemented,
  listRegisteredSteps,
  planStepSpend,
  REGISTERED_STEP_IDS,
  STEP_BILLING_MODES,
  STEP_MODERATION_POSTURES,
  STRICTNESS_PROBE_KEY,
  type AnyBlockStep,
  type BlockStep,
  type StepBillingMode,
} from '~/server/services/blocks/steps';

/**
 * Coverage for the App Blocks step-type registry (RFC #3515 migration step 1).
 *
 * The tests that matter here are the ones that run over the REAL POPULATION
 * (`listRegisteredSteps()`), not over a hardcoded list — a newly registered
 * entry that violates an invariant must fail THESE tests, not slip through
 * because nobody added it to a fixture array.
 *
 * Every guard in `assertStepInvariants` is additionally mutation-tested below
 * with a fixture that violates EXACTLY ONE clause, and each assertion pins the
 * specific message of the guard under test — so a test cannot pass because a
 * neighbouring guard threw first.
 */

// ─────────────────────────────────────────────────────────────────────────────
// A minimal, VALID fixture entry. Every mutation test derives from this by
// breaking one thing, which is what makes "this guard, not its neighbour" a
// property of the fixture rather than a hope.
// ─────────────────────────────────────────────────────────────────────────────
type FixtureParams = { value: number };

const fixtureParamSchema = z.object({ value: z.number().int().min(1).max(10) }).strict();

function makeFixtureStep(overrides: Partial<AnyBlockStep> = {}): AnyBlockStep {
  const base = {
    id: 'fixture-step',
    orchestratorType: 'fixtureType',
    billingMode: 'prepaidFixed',
    moderationPosture: 'none',
    paramSchema: fixtureParamSchema,
    variants: ['default'],
    resolveVariant: () => 'default',
    canonicalParamsFor: (): FixtureParams => ({ value: 1 }),
    priceForVariant: () => 7,
    estimateBuzz: () => 7,
    buildStep: (p: FixtureParams) => ({ $type: 'fixtureType', input: { value: p.value } }),
  } satisfies BlockStep<FixtureParams>;
  return { ...base, ...overrides } as AnyBlockStep;
}

describe('block step registry — the shipped population', () => {
  it('registers at least one step and derives the wire ids from the registry keys', () => {
    const entries = listRegisteredSteps();
    expect(entries.length).toBeGreaterThan(0);
    expect(REGISTERED_STEP_IDS).toEqual(entries.map(([id]) => id));
  });

  it('resolves every registered id and rejects an unregistered one', () => {
    for (const id of REGISTERED_STEP_IDS) expect(getStep(id)).toBeDefined();
    expect(getStep('definitely-not-registered')).toBeUndefined();
  });

  // 🔴 The population test. Enumerated from the registry at RUNTIME, so a step
  // added tomorrow is covered by this test today.
  it('every registered entry satisfies every load-time invariant', () => {
    for (const [id, step] of listRegisteredSteps()) {
      expect(() => assertStepInvariants(id, step)).not.toThrow();
    }
  });

  it("every registered entry's paramSchema is .strict() — an unknown param is REJECTED", () => {
    for (const [id, step] of listRegisteredSteps()) {
      for (const variant of step.variants) {
        const params = step.canonicalParamsFor(variant) as Record<string, unknown>;
        expect(step.paramSchema.safeParse(params).success).toBe(true);
        const withUnknown = { ...params, [STRICTNESS_PROBE_KEY]: 1 };
        expect(
          step.paramSchema.safeParse(withUnknown).success,
          `step '${id}' variant '${variant}' silently ACCEPTED an unknown param — ` +
            'an unknown param on a money path is a wrong-generation bug, not a validation nit'
        ).toBe(false);
      }
    }
  });

  it('every registered entry declares an IMPLEMENTED billing mode and moderation posture', () => {
    for (const [id, step] of listRegisteredSteps()) {
      expect(STEP_BILLING_MODES).toContain(step.billingMode);
      expect(STEP_MODERATION_POSTURES).toContain(step.moderationPosture);
      expect(isBillingModeImplemented(step.billingMode), `step '${id}' billingMode`).toBe(true);
      expect(
        isModerationPostureImplemented(step.moderationPosture),
        `step '${id}' moderationPosture`
      ).toBe(true);
    }
  });

  // Tranche 1's defining property, asserted over the population rather than
  // named per-entry: a deterministic price, computable with no orchestrator
  // round-trip, that equals what the block is shown.
  it('every prepaidFixed entry has an exact positive price that equals its estimate', () => {
    for (const [id, step] of listRegisteredSteps()) {
      if (step.billingMode !== 'prepaidFixed') continue;
      for (const variant of step.variants) {
        const price = step.priceForVariant(variant);
        expect(Number.isSafeInteger(price), `step '${id}' price is an integer`).toBe(true);
        expect(price, `step '${id}' price is positive`).toBeGreaterThan(0);
        const params = step.paramSchema.parse(step.canonicalParamsFor(variant));
        expect(estimateStepBuzz(step, params)).toBe(price);
        expect(planStepSpend(step, params).reserveBuzz).toBe(price);
      }
    }
  });

  it('all three billing modes are DECLARED so future step types are additive', () => {
    // The wire/type surface is the expensive thing to change once the SDK
    // mirrors it, so every mode exists from day one even though only one is
    // implemented. This pins that intent.
    expect([...STEP_BILLING_MODES].sort()).toEqual(['prepaidFixed', 'timeBounded', 'tokenMetered']);
    expect(isBillingModeImplemented('prepaidFixed')).toBe(true);
    expect(isBillingModeImplemented('timeBounded')).toBe(false);
    expect(isBillingModeImplemented('tokenMetered')).toBe(false);
  });

  it('a step with a free-text surface has NO implemented moderation posture', () => {
    // 🔴 The mechanism that makes `chatCompletion` / captioning impossible to
    // register without an explicit, reviewed policy answer in code. If this ever
    // flips to true, someone made that policy decision — make sure they meant to.
    expect(isModerationPostureImplemented('none')).toBe(true);
    expect(isModerationPostureImplemented('promptAudit')).toBe(false);
    expect(isModerationPostureImplemented('textOutput')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MUTATION TESTS. One violated clause each; every assertion pins the message of
// the guard under test, so a green result cannot come from a different guard
// firing first.
// ─────────────────────────────────────────────────────────────────────────────
describe('block step registry — load-time invariants (each guard, mutation-proven)', () => {
  it('the unmutated fixture passes — so every failure below is the mutation, not the fixture', () => {
    expect(() => assertStepInvariants('fixture-step', makeFixtureStep())).not.toThrow();
  });

  it('rejects a registry key that disagrees with step.id', () => {
    expect(() => assertStepInvariants('other-key', makeFixtureStep())).toThrow(
      /registry key must equal step\.id \(got 'fixture-step'\)/
    );
  });

  it('rejects a billing mode with no implemented money-path handler', () => {
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeFixtureStep({
          billingMode: 'tokenMetered',
          // A VALID budget, so this fixture clears every earlier clause and the
          // mode gate is provably what fires — not a missing accessor or a bad
          // budget further up.
          maxBuzzForVariant: () => 5,
        } as Partial<AnyBlockStep>)
      )
    ).toThrow(/billingMode 'tokenMetered' has no implemented money-path handler/);
  });

  it('rejects a moderation posture with no implemented handler', () => {
    expect(() =>
      assertStepInvariants('fixture-step', makeFixtureStep({ moderationPosture: 'textOutput' }))
    ).toThrow(/moderationPosture 'textOutput' has no implemented handler/);
  });

  it('rejects an entry declaring no variants', () => {
    expect(() => assertStepInvariants('fixture-step', makeFixtureStep({ variants: [] }))).toThrow(
      /must declare at least one variant/
    );
  });

  it('rejects canonical params that do not satisfy the param schema', () => {
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeFixtureStep({ canonicalParamsFor: () => ({ value: 999 }) })
      )
    ).toThrow(/canonicalParamsFor\(\) must satisfy paramSchema/);
  });

  it('rejects canonical params that are not a plain object', () => {
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeFixtureStep({
          paramSchema: z.number(),
          canonicalParamsFor: () => 5,
        } as Partial<AnyBlockStep>)
      )
    ).toThrow(/canonicalParamsFor\(\) must return a plain params object/);
  });

  // 🔴 THE STRICTNESS GUARD. `blockTextToImageBodySchema` is not `.strict()`, and
  // that is exactly what let an older host silently strip `sourceImages` and bill
  // the wrong generation. This mutation is that bug, in registry form.
  it('rejects a paramSchema that is NOT .strict() (an unknown param would be silently dropped)', () => {
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeFixtureStep({
          // Same shape, WITHOUT `.strict()` — an unknown key is dropped, not rejected.
          paramSchema: z.object({ value: z.number().int().min(1).max(10) }),
        } as Partial<AnyBlockStep>)
      )
    ).toThrow(/paramSchema must be \.strict\(\) — it accepted an unknown param/);
  });

  it('rejects canonical params that resolve to a DIFFERENT variant than they were built for', () => {
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeFixtureStep({
          variants: ['default', 'other'],
          resolveVariant: () => 'default',
          canonicalParamsFor: (): FixtureParams => ({ value: 1 }),
        } as Partial<AnyBlockStep>)
      )
    ).toThrow(/canonicalParamsFor\(\) resolves to variant 'default', not 'other'/);
  });

  // 🔴 THE prepaidFixed INVARIANT — its OWN enforced clause, not an exemption
  // from the timeBounded one.
  it('rejects a prepaidFixed price that is not a positive integer', () => {
    expect(() =>
      assertStepInvariants('fixture-step', makeFixtureStep({ priceForVariant: () => 0 }))
    ).toThrow(/prepaidFixed price \(0\) must be a positive safe integer/);

    expect(() =>
      assertStepInvariants('fixture-step', makeFixtureStep({ priceForVariant: () => 2.5 }))
    ).toThrow(/prepaidFixed price \(2\.5\) must be a positive safe integer/);

    expect(() =>
      assertStepInvariants('fixture-step', makeFixtureStep({ priceForVariant: () => -3 }))
    ).toThrow(/prepaidFixed price \(-3\) must be a positive safe integer/);
  });

  it('rejects a prepaidFixed estimate that disagrees with the declared price', () => {
    // The money-relevant clause: the block is SHOWN the estimate and CHARGED the
    // price. This is the divergence a bare "the price is an integer" check misses.
    expect(() =>
      assertStepInvariants('fixture-step', makeFixtureStep({ estimateBuzz: () => 3 }))
    ).toThrow(/prepaidFixed estimateBuzz \(3\) must equal the declared price \(7\)/);
  });

  // 🔴 REACHABILITY. The per-variant budget invariants run BEFORE the
  // implemented-billing-mode gate on purpose. Had the gate run first, these two
  // branches would be structurally unable to execute for `timeBounded` /
  // `tokenMetered` — the gate rejects every such entry — and the registry would
  // carry two invariants that no mutation could ever kill. Ordered as they are,
  // a fixture reaches its own budget guard and the tests below genuinely prove
  // it, so the invariant is real on the day those modes are implemented rather
  // than the day someone notices it never ran.
  it('enforces the timeBounded maxBuzz === ceil(stepTimeoutSeconds) invariant', () => {
    const timeBounded = (over: Record<string, unknown>) =>
      makeFixtureStep({ billingMode: 'timeBounded', ...over } as Partial<AnyBlockStep>);

    // maxBuzz below what the timeout physically enforces → the job can outspend
    // the reservation.
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        timeBounded({ budgetForVariant: () => ({ maxBuzz: 90, stepTimeoutSeconds: 150 }) })
      )
    ).toThrow(/timeBounded maxBuzz \(90\) must equal ceil\(stepTimeoutSeconds\) \(150\)/);

    // maxBuzz above it → a ceiling the timeout cannot guarantee.
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        timeBounded({ budgetForVariant: () => ({ maxBuzz: 150, stepTimeoutSeconds: 90 }) })
      )
    ).toThrow(/timeBounded maxBuzz \(150\) must equal ceil\(stepTimeoutSeconds\) \(90\)/);

    // A non-positive timeout is rejected by its own clause, not the equality one.
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        timeBounded({ budgetForVariant: () => ({ maxBuzz: 0, stepTimeoutSeconds: 0 }) })
      )
    ).toThrow(/timeBounded stepTimeoutSeconds \(0\) must be positive/);

    // A CONSISTENT budget passes the budget clause and is then rejected by the
    // separate implemented-handler gate — proving the two guards are distinct
    // and that a correct budget is not what makes the mode unregisterable.
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        timeBounded({ budgetForVariant: () => ({ maxBuzz: 150, stepTimeoutSeconds: 150 }) })
      )
    ).toThrow(/billingMode 'timeBounded' has no implemented money-path handler/);
  });

  it('enforces the tokenMetered positive-maxBuzz invariant', () => {
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeFixtureStep({
          billingMode: 'tokenMetered',
          maxBuzzForVariant: () => 0,
        } as Partial<AnyBlockStep>)
      )
    ).toThrow(/tokenMetered maxBuzz \(0\) must be a positive safe integer/);

    // A valid maxBuzz clears the budget clause and falls through to the
    // implemented-handler gate.
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeFixtureStep({
          billingMode: 'tokenMetered',
          maxBuzzForVariant: () => 500,
        } as Partial<AnyBlockStep>)
      )
    ).toThrow(/billingMode 'tokenMetered' has no implemented money-path handler/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DISPATCH. The RFC's core claim: adding a capability must be additive, and
// adding a MODE must not require router surgery.
// ─────────────────────────────────────────────────────────────────────────────
describe('block step registry — billing-mode dispatch', () => {
  it('prepaidFixed plans a FINAL reservation that never touches the post-paid settle machinery', () => {
    const step = makeFixtureStep();
    const params = step.paramSchema.parse(step.canonicalParamsFor('default'));
    const plan = planStepSpend(step, params);
    expect(plan).toEqual({ reserveBuzz: 7, postPaidSettle: false, stepTimeoutSeconds: null });
  });

  // 🔴 STRUCTURAL PROOF that dispatch is on `billingMode`, not on the step id and
  // not on the wire `kind`. A fixture declaring a DIFFERENT mode is routed to
  // that mode's handler — reaching it needs no change to the router, the schema,
  // or this dispatcher's call sites. The `timeBounded` handler is currently a
  // fail-closed "not implemented", which is the CORRECT routing outcome for a
  // mode with no money path yet: it can never silently ride prepaidFixed's
  // reservation logic.
  it('routes a fixture entry with a DIFFERENT billing mode to that mode — no router change', () => {
    const timeBounded = makeFixtureStep({
      billingMode: 'timeBounded',
      budgetForVariant: () => ({ maxBuzz: 150, stepTimeoutSeconds: 150 }),
    } as Partial<AnyBlockStep>);
    const params = timeBounded.paramSchema.parse(timeBounded.canonicalParamsFor('default'));

    // It reached the timeBounded slot — NOT prepaidFixed's (which would have
    // happily returned `{ reserveBuzz: 7 }` from the fixture's `priceForVariant`).
    expect(() => planStepSpend(timeBounded, params)).toThrow(
      /billing mode 'timeBounded' has no money-path handler/
    );
    expect(() => estimateStepBuzz(timeBounded, params)).toThrow(
      /billing mode 'timeBounded' has no money-path handler/
    );

    const tokenMetered = makeFixtureStep({
      billingMode: 'tokenMetered',
      maxBuzzForVariant: () => 500,
    } as Partial<AnyBlockStep>);
    expect(() => planStepSpend(tokenMetered, params)).toThrow(
      /billing mode 'tokenMetered' has no money-path handler/
    );
  });

  it('the dispatcher is TOTAL over the declared billing modes', () => {
    // No mode may be absent from the handler table — an absent key would read as
    // `undefined` at runtime and throw a TypeError that looks like a bug rather
    // than a deliberate fail-closed gate.
    const step = makeFixtureStep();
    const params = step.paramSchema.parse(step.canonicalParamsFor('default'));
    for (const mode of STEP_BILLING_MODES) {
      const entry = makeFixtureStep({
        billingMode: mode,
        budgetForVariant: () => ({ maxBuzz: 1, stepTimeoutSeconds: 1 }),
        maxBuzzForVariant: () => 1,
      } as Partial<AnyBlockStep>);
      let error: unknown;
      try {
        planStepSpend(entry, params);
      } catch (e) {
        error = e;
      }
      if (isBillingModeImplemented(mode as StepBillingMode)) {
        expect(error).toBeUndefined();
      } else {
        // A deliberate, named failure — never `undefined is not a function`.
        expect(String(error)).toContain(`billing mode '${mode}' has no money-path handler`);
      }
    }
  });
});
