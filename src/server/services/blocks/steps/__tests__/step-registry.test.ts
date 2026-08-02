import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  assertOrchestratorTypesUnique,
  assertStepInvariants,
  containsAirReference,
  estimateStepBuzz,
  getStep,
  getStepByOrchestratorType,
  isBillingModeImplemented,
  isModerationPostureImplemented,
  isResourcePolicyImplemented,
  listRegisteredSteps,
  mediaFromBlobs,
  NATIVELY_EXTRACTED_STEP_TYPES,
  planStepSpend,
  postureRequiresAuditableText,
  REGISTERED_STEP_IDS,
  STEP_BILLING_MODES,
  STEP_MODERATION_POSTURES,
  STRICTNESS_PROBE_KEY,
  type AnyBlockStep,
  type BlockStep,
  type StepBillingMode,
} from '~/server/services/blocks/steps';
import type { OrchestratorBlobLike } from '~/server/services/blocks/steps/output';

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

/** The orchestrator-shaped completed step the fixture's extractor reads. */
const FIXTURE_OUTPUT_STEP = {
  $type: 'fixtureType',
  output: {
    blob: { url: 'https://blobs.example/fixture.webp', available: true, width: 4, height: 5 },
  },
};

function makeFixtureStep(overrides: Partial<AnyBlockStep> = {}): AnyBlockStep {
  const base = {
    id: 'fixture-step',
    orchestratorType: 'fixtureType',
    billingMode: 'prepaidFixed',
    moderationPosture: 'none',
    resourcePolicy: { kind: 'none' },
    paramSchema: fixtureParamSchema,
    variants: ['default'],
    resolveVariant: () => 'default',
    canonicalParamsFor: (): FixtureParams => ({ value: 1 }),
    priceForVariant: () => 7,
    estimateBuzz: () => 7,
    buildStep: (p: FixtureParams) => ({ $type: 'fixtureType', input: { value: p.value } }),
    extractOutput: (step: unknown) =>
      mediaFromBlobs(
        (step as { output?: { blob?: OrchestratorBlobLike | null } } | null | undefined)?.output
          ?.blob
      ),
    canonicalOutputFor: (): unknown => FIXTURE_OUTPUT_STEP,
  } satisfies BlockStep<FixtureParams>;
  return { ...base, ...overrides } as AnyBlockStep;
}

/**
 * A minimal VALID `'promptAudit'` fixture — the same base, plus the two fields
 * that posture requires.
 *
 * 🔴 It is asserted to pass unmutated (first test in the mutation block), which
 * is what makes every mutation below provably die to the clause its assertion
 * names rather than to some earlier clause rejecting the whole shape.
 */
function makeAuditedFixtureStep(overrides: Partial<AnyBlockStep> = {}): AnyBlockStep {
  return makeFixtureStep({
    moderationPosture: 'promptAudit',
    auditableText: (p: FixtureParams) => ({
      prompt: `fixture prompt ${p.value}`,
      negativePrompt: 'fixture negative',
    }),
    ...overrides,
  } as Partial<AnyBlockStep>);
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

  // 🔴 THE FIX-1 POPULATION TEST. Every registered step must be RETRIEVABLE on
  // BOTH read surfaces. Run over `listRegisteredSteps()` so a step registered
  // tomorrow is covered by this test today — which is the whole reason output
  // extraction became a registry field instead of a fourth hardcoded branch.
  it('every registered entry is resolvable by $type and surfaces media from its canonical output', () => {
    for (const [id, step] of listRegisteredSteps()) {
      expect(
        getStepByOrchestratorType(step.orchestratorType),
        `step '${id}' is not resolvable by its own orchestratorType — both workflow.service ` +
          'extractors would skip it and its output would be unreachable'
      ).toBe(step);
      expect(
        NATIVELY_EXTRACTED_STEP_TYPES,
        `step '${id}' shadows a natively-extracted $type`
      ).not.toContain(step.orchestratorType);
      for (const variant of step.variants) {
        const media = step.extractOutput(step.canonicalOutputFor(variant));
        expect(
          media.length,
          `step '${id}' variant '${variant}' extracted no media`
        ).toBeGreaterThan(0);
        for (const item of media) expect(item.url.length).toBeGreaterThan(0);
      }
    }
  });

  it('every registered entry declares an IMPLEMENTED resource policy, enforced against its BUILT step', () => {
    for (const [id, step] of listRegisteredSteps()) {
      expect(isResourcePolicyImplemented(step.resourcePolicy), `step '${id}' resourcePolicy`).toBe(
        true
      );
      if (step.resourcePolicy.kind !== 'none') continue;
      for (const variant of step.variants) {
        const params = step.paramSchema.parse(step.canonicalParamsFor(variant));
        expect(
          containsAirReference(step.buildStep(params).input),
          `step '${id}' declares resourcePolicy 'none' but its built step carries an AIR — ` +
            'that reaches the orchestrator around the generation-graph entitlement belt'
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

  it('free-text INPUT is implemented; free-text OUTPUT still is not', () => {
    // 🔴 The mechanism that makes a text-producing step impossible to register
    // without an explicit, reviewed policy answer in code.
    //
    // `'promptAudit'` (free-text INPUT) is now implemented: #3527 answered that
    // half — mature content is permitted for App Blocks, bounded by the token's
    // server-minted maturity ceiling, so a free-text input needs the SAME
    // `auditPromptServer` pass `textToImage`/`customComfy` run, not a new policy.
    //
    // `'textOutput'` is unchanged and deliberately so: generated text is scanned
    // by nothing on any current path. If THAT ever flips to true, someone made a
    // content-policy decision — make sure they meant to.
    expect(isModerationPostureImplemented('none')).toBe(true);
    expect(isModerationPostureImplemented('promptAudit')).toBe(true);
    expect(isModerationPostureImplemented('textOutput')).toBe(false);
  });

  // 🔴 LABELLED HONESTLY: an INVARIANT GUARD, not regression coverage. Every
  // registered entry today declares `'none'`, so the `'promptAudit'` branch of
  // this loop cannot currently execute — no mutation of the posture↔auditableText
  // rule can fail it over the shipped population. It becomes real coverage the
  // day a `'promptAudit'` entry is registered. The guard itself is
  // mutation-proven below against fixtures, which is where its evidence lives.
  it('every registered entry agrees with the posture ↔ auditableText rule', () => {
    for (const [id, step] of listRegisteredSteps()) {
      if (postureRequiresAuditableText(step.moderationPosture)) {
        expect(typeof step.auditableText, `step '${id}' must name its auditable text`).toBe(
          'function'
        );
        for (const variant of step.variants) {
          const params = step.paramSchema.parse(step.canonicalParamsFor(variant));
          expect(
            step.auditableText!(params).prompt.trim().length,
            `step '${id}' variant '${variant}' would audit NOTHING`
          ).toBeGreaterThan(0);
        }
      } else {
        expect(
          step.auditableText,
          `step '${id}' declares auditable text its posture never audits`
        ).toBeUndefined();
      }
    }
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

  // ── 🔴 THE `'promptAudit'` POSTURE — "audits nothing" must be impossible ────
  //
  // The defect class this guards is the one #3538 had to fix for `extractOutput`:
  // a REQUIRED field that a new entry can satisfy vacuously. `auditPromptServer`
  // RETURNS EARLY on an empty prompt, so `() => ({ prompt: '' })` would be a
  // declared posture that runs, audits nothing, and reports success. Both
  // directions of the declaration rule and the non-vacuity probe are below.

  it('the promptAudit fixture PASSES unmutated — every failure below is the mutation', () => {
    // 🔴 REACHABILITY. Without this, each mutation below could be dying to a
    // clause that rejects the whole `'promptAudit'` shape rather than to the one
    // named in its assertion.
    expect(() => assertStepInvariants('fixture-step', makeAuditedFixtureStep())).not.toThrow();
  });

  it("rejects a 'promptAudit' entry that declares NO auditableText (a posture with no input)", () => {
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeFixtureStep({ moderationPosture: 'promptAudit' } as Partial<AnyBlockStep>)
      )
    ).toThrow(
      /moderationPosture 'promptAudit' requires an auditableText\(\) declaration naming the params that carry user text/
    );
  });

  it('rejects an entry that declares auditableText under a posture that never audits it', () => {
    // The reverse direction. Text that LOOKS covered and is not: the field is
    // never called, so it reaches the orchestrator unaudited.
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeFixtureStep({
          moderationPosture: 'none',
          auditableText: () => ({ prompt: 'a cat' }),
        } as Partial<AnyBlockStep>)
      )
    ).toThrow(/declares auditableText\(\) but moderationPosture 'none' never audits it/);
  });

  it('rejects auditableText that returns an EMPTY prompt (the vacuous-posture case)', () => {
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeAuditedFixtureStep({ auditableText: () => ({ prompt: '' }) } as Partial<AnyBlockStep>)
      )
    ).toThrow(/auditableText\(\) returned no prompt text for canonicalParamsFor\(\)/);
  });

  it('rejects auditableText that returns WHITESPACE (auditPromptServer trims and returns early)', () => {
    // 🔴 Not a nit: the early return in `auditPromptServer` is
    // `if (!prompt || !prompt.trim()) return;` — whitespace is exactly as vacuous
    // as an empty string, and a `.length > 0` check would have accepted it.
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeAuditedFixtureStep({
          auditableText: () => ({ prompt: '   \n\t ' }),
        } as Partial<AnyBlockStep>)
      )
    ).toThrow(/auditableText\(\) returned no prompt text for canonicalParamsFor\(\)/);
  });

  it('rejects auditableText that omits prompt entirely', () => {
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeAuditedFixtureStep({ auditableText: () => ({}) } as unknown as Partial<AnyBlockStep>)
      )
    ).toThrow(/auditableText\(\) returned no prompt text for canonicalParamsFor\(\)/);
  });

  it('rejects a non-string negativePrompt (auditPromptServer could not read it)', () => {
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeAuditedFixtureStep({
          auditableText: () => ({ prompt: 'a cat', negativePrompt: 42 }),
        } as unknown as Partial<AnyBlockStep>)
      )
    ).toThrow(/auditableText\(\) returned a non-string negativePrompt/);
  });

  // ── 🔴 FIX 3 — the ENTITLEMENT axis ────────────────────────────────────────
  // `BlockRecipe` carries `resourceAllowlist` + `checkpointPolicy`; the first
  // draft of this generalization dropped both, while this PR's own triage
  // disqualified `imageUpscaler` PRECISELY because its arbitrary-AIR `model`
  // field would reach the orchestrator around the entitlement belt. Without a
  // required, fail-closed field, an entry with exactly that shape registers
  // cleanly and every other invariant passes.

  it('rejects a resource policy with no implemented handler', () => {
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeFixtureStep({
          resourcePolicy: { kind: 'staticAllowlist', airs: ['urn:air:sdxl:checkpoint:x@1'] },
        } as Partial<AnyBlockStep>)
      )
    ).toThrow(/resourcePolicy 'staticAllowlist' has no implemented handler/);
  });

  // 🔴 THE `imageUpscaler` CASE, as a registry-level guard. The entry declares
  // 'none' honestly-looking, but its builder forwards an AIR URN. Every other
  // invariant passes: the params parse, the schema is strict, the price is a
  // positive integer that equals the estimate, the variant resolves, the output
  // extracts. Only this clause catches it.
  it("rejects a resourcePolicy 'none' whose BUILT step actually carries an AIR reference", () => {
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeFixtureStep({
          buildStep: (p: { value: number }) => ({
            $type: 'fixtureType',
            input: {
              value: p.value,
              model: 'urn:air:sdxl:checkpoint:civitai:4384@128713',
            },
          }),
        } as Partial<AnyBlockStep>)
      )
    ).toThrow(/resourcePolicy 'none' is contradicted — buildStep\(\) emitted an AIR reference/);
  });

  it('finds an AIR nested anywhere in the built input, not just at the top level', () => {
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeFixtureStep({
          buildStep: (p: { value: number }) => ({
            $type: 'fixtureType',
            input: { value: p.value, nested: { deep: [{ air: 'URN:AIR:SDXL:lora:civitai:1@2' }] } },
          }),
        } as Partial<AnyBlockStep>)
      )
    ).toThrow(/resourcePolicy 'none' is contradicted/);
  });

  // ── 🔴 FIX 1 — output extraction ───────────────────────────────────────────
  // A registered step whose output nothing can read is a capability the caller
  // is CHARGED for and can never retrieve: it polls to `succeeded` with an empty
  // result forever. No other invariant here can see that.

  it('rejects an entry whose extractOutput surfaces NOTHING for its own canonical output', () => {
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeFixtureStep({ extractOutput: () => [] } as Partial<AnyBlockStep>)
      )
    ).toThrow(/extractOutput\(\) returned no media for canonicalOutputFor\(\)/);
  });

  // The realistic shape of the shipped bug: the extractor reads the WRONG key
  // (`images`/`blobs` instead of the singular `blob` convertImage returns), so
  // it silently yields nothing on a real response.
  it('rejects an extractOutput that reads the wrong output key', () => {
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeFixtureStep({
          extractOutput: (step: unknown) =>
            mediaFromBlobs(
              (step as { output?: { blobs?: OrchestratorBlobLike[] } } | undefined)?.output?.blobs
            ),
        } as Partial<AnyBlockStep>)
      )
    ).toThrow(/extractOutput\(\) returned no media for canonicalOutputFor\(\)/);
  });

  it('rejects extracted media with an empty url (a block would render a dead link)', () => {
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeFixtureStep({
          extractOutput: () => [{ url: '', width: null, height: null, nsfwLevel: null }],
        } as Partial<AnyBlockStep>)
      )
    ).toThrow(/extractOutput\(\) returned media with no url/);
  });

  it('rejects an orchestratorType that SHADOWS a natively-extracted $type', () => {
    // Placing the registry branch before workflow.service's native `$type` filter
    // is only safe because of this guard — otherwise a registered entry could
    // silently take over textToImage extraction.
    for (const nativeType of NATIVELY_EXTRACTED_STEP_TYPES) {
      expect(() =>
        assertStepInvariants(
          'fixture-step',
          makeFixtureStep({ orchestratorType: nativeType } as Partial<AnyBlockStep>)
        )
      ).toThrow(
        /is natively extracted by workflow\.service — a registered step must not shadow it/
      );
    }
  });

  it('rejects two entries claiming the SAME orchestratorType (single-winner lookup)', () => {
    expect(() =>
      assertOrchestratorTypesUnique([
        ['a', makeFixtureStep({ id: 'a' } as Partial<AnyBlockStep>)],
        ['b', makeFixtureStep({ id: 'b' } as Partial<AnyBlockStep>)],
      ])
    ).toThrow(/orchestratorType 'fixtureType' is already claimed by 'a'/);
  });

  it('accepts distinct orchestratorTypes', () => {
    expect(() =>
      assertOrchestratorTypesUnique([
        ['a', makeFixtureStep({ id: 'a' } as Partial<AnyBlockStep>)],
        ['b', makeFixtureStep({ id: 'b', orchestratorType: 'otherType' } as Partial<AnyBlockStep>)],
      ])
    ).not.toThrow();
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
    expect(plan).toEqual({
      reserveBuzz: 7,
      postPaidSettle: false,
      // 🔴 The reservation is an EXACT price, so an overage is a permanent cap
      // shortfall the submit path must top up. This flag is what keeps that
      // `prepaidFixed`-shaped correction from running for a mode whose
      // reservation is a CEILING (which the post-paid settle would then unwind
      // from the un-topped-up number). Mutually exclusive with `postPaidSettle`.
      correctReservationOverage: true,
      stepTimeoutSeconds: null,
    });
  });

  // 🔴 LABELLED HONESTLY: this is an INVARIANT GUARD, not regression coverage.
  // Only `prepaidFixed` is registered, so `correctReservationOverage` is always
  // true and `postPaidSettle` always false — no mutation of the ROUTER'S gate on
  // this flag can fail today (verified: deleting `if (plan.correctReservationOverage)`
  // kills zero tests). What IS proven is that the flag is load-bearing: flipping
  // it to false in the handler kills 6 tests, so the router really reads it. The
  // false branch becomes reachable — and this guard becomes real coverage — when
  // a `timeBounded` entry is registered.
  it('correctReservationOverage and postPaidSettle are MUTUALLY EXCLUSIVE for every mode', () => {
    // Over the real population, not a fixture: a future entry that sets both
    // would double-handle its overage — topped up here AND settled down there.
    for (const [id, step] of listRegisteredSteps()) {
      for (const variant of step.variants) {
        const params = step.paramSchema.parse(step.canonicalParamsFor(variant));
        const plan = planStepSpend(step, params);
        expect(
          plan.correctReservationOverage && plan.postPaidSettle,
          `step '${id}' plans BOTH an overage correction and a post-paid settle`
        ).toBe(false);
      }
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// The shared extraction primitives. `mediaFromBlobs` is the ONE copy of the
// availability filter every entry uses — a per-entry reimplementation is how one
// copy gets a fix and the others don't.
// ─────────────────────────────────────────────────────────────────────────────
describe('mediaFromBlobs — the shared availability filter', () => {
  const url = 'https://blobs.example/a.webp';

  it('accepts a SINGLE blob (the convertImage shape) and a list alike', () => {
    const single = mediaFromBlobs({ url, available: true, width: 3, height: 4 });
    expect(single).toEqual([{ url, width: 3, height: 4, nsfwLevel: null }]);
    expect(mediaFromBlobs([{ url, available: true }])).toEqual([
      { url, width: null, height: null, nsfwLevel: null },
    ]);
  });

  it('DROPS unavailable, url-less and empty-url blobs rather than handing over dead links', () => {
    expect(
      mediaFromBlobs([
        { url, available: false },
        { url: '', available: true },
        { url: null, available: true },
        { available: true },
      ])
    ).toEqual([]);
  });

  it('is total over absent/null input and skips null entries', () => {
    expect(mediaFromBlobs(undefined)).toEqual([]);
    expect(mediaFromBlobs(null)).toEqual([]);
    expect(mediaFromBlobs([null, undefined, { url, available: true }])).toHaveLength(1);
  });

  it('passes the RAW orchestrator rating string through — never a mapped bitflag', () => {
    // The numeric browsing-level mapping lives in exactly one place
    // (`nsfwLevelFromContentRating`, in the projection). A registry entry must
    // not be able to invent its own.
    expect(mediaFromBlobs({ url, available: true, nsfwLevel: 'pg13' })[0].nsfwLevel).toBe('pg13');
    expect(mediaFromBlobs({ url, available: true, nsfwLevel: 'na' })[0].nsfwLevel).toBe('na');
  });
});

describe('containsAirReference — the entitlement probe', () => {
  it('finds an AIR in a string, an array, and a nested object, case-insensitively', () => {
    expect(containsAirReference('urn:air:sdxl:checkpoint:civitai:4384@128713')).toBe(true);
    expect(containsAirReference(['x', 'URN:AIR:sdxl:lora:civitai:1@2'])).toBe(true);
    expect(containsAirReference({ a: { b: [{ c: 'urn:air:flux:vae:x@1' }] } })).toBe(true);
  });

  it('does not false-positive on ordinary step input', () => {
    expect(
      containsAirReference({
        image: 'https://image.civitai.com/x.png',
        output: { format: 'webp', quality: 90, hideMetadata: true },
        transforms: [{ type: 'resize', targetWidth: 512 }],
      })
    ).toBe(false);
    expect(containsAirReference(null)).toBe(false);
    expect(containsAirReference(42)).toBe(false);
  });
});
