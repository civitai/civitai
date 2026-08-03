import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  acceptablePosturesFor,
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
  postureProducesMedia,
  postureRequiresAuditableText,
  postureRequiresTextExtraction,
  REGISTERED_STEP_IDS,
  stepOutputShape,
  resolveStepVariant,
  STEP_BILLING_MODES,
  STEP_MODERATION_POSTURES,
  STEP_TYPE_ACCEPTABLE_POSTURES,
  STRICTNESS_PROBE_KEY,
  type AnyBlockStep,
  type BlockStep,
  type StepBillingMode,
  type StepModerationPosture,
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
  const merged = { ...base, ...overrides } as AnyBlockStep;
  // 🔴 THE FIXTURE MUST BE INTERNALLY CONSISTENT. Clause 7a requires
  // `buildStep().$type === orchestratorType`, and most tests below vary
  // `orchestratorType` alone to exercise the $type-keyed clauses (1b, 9). With
  // a hardcoded built `$type` those fixtures would all die to 7a instead —
  // testing nothing they claim to test. So the built type FOLLOWS the declared
  // one unless a test overrides `buildStep` explicitly, which is precisely what
  // the clause-7a tests do.
  if (overrides.buildStep === undefined) {
    merged.buildStep = (p: unknown) => ({
      $type: merged.orchestratorType,
      input: { value: (p as FixtureParams).value },
    });
  }
  return merged;
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

/**
 * The generated text the `'textOutput'` fixture's extractor reads.
 *
 * 🔴 NO `blob` KEY, AND THAT IS THE POINT. Every `$type` licensed for
 * `'textOutput'` is text-producing and none is media-producing, so a canonical
 * output carrying an image blob would be a fixture no real adopter could
 * produce — which is exactly the fiction the media-XOR-text fix removed. This
 * sample is what a `chatCompletion`-shaped completed step actually looks like.
 */
const FIXTURE_TEXT_OUTPUT_STEP = {
  $type: 'fixtureType',
  output: {
    choices: [{ message: { content: 'a generated reply' } }],
  },
};

/**
 * A minimal VALID `'textOutput'` fixture — the same base, plus what that posture
 * requires (an `extractText` declaration and a canonical output carrying text)
 * and MINUS what it forbids (`extractOutput`).
 *
 * 🔴 THE DELETE IS LOAD-BEARING, NOT TIDINESS. Registry clause 8-ii rejects a
 * text-posture entry that declares a media extractor, because
 * `StepOutputMedia.url` is a bare string that reaches `snapshot.imageUrls` and
 * `AppWorkflow.images[].url` WITHOUT passing the output scan. A fixture that
 * kept the base's `extractOutput` would not register — and before the fix, the
 * inverse was true: an honest text entry could not register WITHOUT one, which
 * is how the media-url smuggle became the path of least resistance.
 */
function makeTextOutputFixtureStep(overrides: Partial<AnyBlockStep> = {}): AnyBlockStep {
  const step = makeFixtureStep({
    moderationPosture: 'textOutput',
    canonicalOutputFor: (): unknown => FIXTURE_TEXT_OUTPUT_STEP,
    extractText: (step: unknown) =>
      (
        (step as { output?: { choices?: Array<{ message?: { content?: string } }> } })?.output
          ?.choices ?? []
      )
        .map((c) => c.message?.content ?? '')
        .filter((t) => t.length > 0),
    ...overrides,
  } as Partial<AnyBlockStep>);
  // Genuinely absent, not present-and-undefined — the shape a real entry has.
  if (!('extractOutput' in overrides)) {
    delete (step as { extractOutput?: unknown }).extractOutput;
  }
  return step;
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
  it('every registered entry is resolvable by $type and surfaces its OWN declared output shape', () => {
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
        const sample = step.canonicalOutputFor(variant);
        // 🔴 POSTURE-GATED, mirroring the read path. A `'textOutput'` entry has
        // no `extractOutput` at all (media XOR text), so asserting media for it
        // would be asserting a shape the registry FORBIDS — and this loop runs
        // over the live population, so it must stay correct for the first text
        // entry registered.
        if (postureProducesMedia(step.moderationPosture)) {
          const media = step.extractOutput!(sample);
          expect(
            media.length,
            `step '${id}' variant '${variant}' extracted no media`
          ).toBeGreaterThan(0);
          for (const item of media) expect(item.url.length).toBeGreaterThan(0);
        } else {
          expect(
            step.extractOutput,
            `step '${id}' publishes TEXT but declares a media extractor — an unscanned channel`
          ).toBeUndefined();
          const texts = step.extractText!(sample);
          expect(
            texts.length,
            `step '${id}' variant '${variant}' extracted no text`
          ).toBeGreaterThan(0);
        }
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

  it('every declared posture now has an implemented handler', () => {
    // 🔴 The mechanism that makes a text-producing step impossible to register
    // without an explicit, reviewed policy answer in code.
    //
    // `'promptAudit'` (free-text INPUT) was answered by #3527: mature content is
    // permitted for App Blocks, bounded by the token's server-minted maturity
    // ceiling, so a free-text input needs the SAME `auditPromptServer` pass
    // `textToImage`/`customComfy` run, not a new policy.
    //
    // `'textOutput'` (free-text OUTPUT) is now answered too: an owner-approved
    // 15-label `xGuardModeration` text scan at the READ boundary, withholding on
    // a hit in either policy tier and on any scanner failure. The policy lives
    // in `steps/text-output-moderation`; the phase wiring in `steps/moderation`.
    //
    // 🔴 THIS ASSERTION NO LONGER CARRIES THE "un-registrable until someone
    // answers" PROPERTY FOR ANY EXISTING POSTURE — all three are answered. What
    // still carries it is `posturePhaseRequirements` + the phase table assert:
    // a NEW posture added to the union with no handler in its required phase is
    // still a load-time failure. Do not read a green here as proof that gate is
    // intact; the phase-table tests are where that evidence lives.
    expect(isModerationPostureImplemented('none')).toBe(true);
    expect(isModerationPostureImplemented('promptAudit')).toBe(true);
    expect(isModerationPostureImplemented('textOutput')).toBe(true);
  });

  it('🔴 stepOutputShape is TOTAL, and media/text genuinely PARTITION the postures', () => {
    // 🔴 THE ONE PREDICATE THE WHOLE MEDIA-XOR-TEXT RULE BOTTOMS OUT IN — the
    // type-level surface union, registry clauses 8/8a, and the posture gate on
    // BOTH `workflow.service` extractors all read it. If it ever returned
    // `undefined` for a posture (a new union member with no `case`), the media
    // branch would silently stop firing and a text step's `extractOutput` would
    // start reaching `imageUrls` again. Enumerated from the live posture list, so
    // a posture added tomorrow fails this today.
    for (const posture of STEP_MODERATION_POSTURES) {
      const shape = stepOutputShape(posture);
      expect(['media', 'text'], `posture '${posture}' has no declared output shape`).toContain(
        shape
      );
      // Exact complements, not two independently-maintained lists.
      expect(postureProducesMedia(posture)).toBe(shape === 'media');
      expect(postureRequiresTextExtraction(posture)).toBe(shape === 'text');
      expect(postureProducesMedia(posture)).not.toBe(postureRequiresTextExtraction(posture));
    }
    // The concrete assignment, pinned literally — a silent flip of `'textOutput'`
    // to `'media'` would re-open the smuggling channel while every structural
    // assertion above still passed.
    expect(stepOutputShape('none')).toBe('media');
    expect(stepOutputShape('promptAudit')).toBe('media');
    expect(stepOutputShape('textOutput')).toBe('text');
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
    // 🔴 THE FIXTURE POSTURE IS UNDECLARED ON PURPOSE. Every posture in the
    // union now HAS a handler, so this clause is no longer reachable with a real
    // posture value — and a guard nothing can reach is a guard nobody is
    // testing. An off-union value is what the clause actually defends against
    // now: a posture added to `StepModerationPosture` (or arriving from a
    // non-literal source later) before its handler exists.
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeFixtureStep({ moderationPosture: 'audioOutput' as StepModerationPosture })
      )
    ).toThrow(/moderationPosture 'audioOutput' has no implemented handler/);
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

  // ── 🔴 THE `'textOutput'` POSTURE — clauses 1c + 8a ────────────────────────
  //
  // The OUTPUT-side twins of the two clauses above, guarding the same defect
  // class one phase later. `extractText` is what the scan reads AND what a
  // release publishes, so an entry that satisfies it vacuously is a step that
  // charges Buzz, succeeds, and can never return a word — the MEDIA version of
  // which this registry already shipped once (clause 8).

  it('the textOutput fixture PASSES unmutated — every failure below is the mutation', () => {
    // 🔴 REACHABILITY. Without this, each mutation below could be dying to a
    // clause that rejects the whole `'textOutput'` shape rather than to the one
    // named in its assertion.
    expect(() => assertStepInvariants('fixture-step', makeTextOutputFixtureStep())).not.toThrow();
  });

  it("rejects a 'textOutput' entry that declares NO extractText (a posture with no output)", () => {
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeFixtureStep({ moderationPosture: 'textOutput' } as Partial<AnyBlockStep>)
      )
    ).toThrow(
      /moderationPosture 'textOutput' requires an extractText\(\) declaration naming the generated text to scan/
    );
  });

  it('rejects an entry that declares extractText under a posture that never scans it', () => {
    // The reverse direction. An extractor that LOOKS like generated-text
    // coverage and is never called — the read path only invokes it for a
    // `'textOutput'` entry.
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeFixtureStep({
          moderationPosture: 'none',
          extractText: () => ['a generated reply'],
        } as Partial<AnyBlockStep>)
      )
    ).toThrow(/declares extractText\(\) but moderationPosture 'none' never scans it/);
  });

  it('rejects extractText that returns an EMPTY array (the inert-capability case)', () => {
    // 🔴 The `() => []` escape clause 8 exists for, on the text axis. Not a
    // moderation hole — the read path publishes only what the extractor returns,
    // so nothing unscanned escapes — but a capability that can never speak.
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeTextOutputFixtureStep({ extractText: () => [] } as Partial<AnyBlockStep>)
      )
    ).toThrow(/extractText\(\) returned no text for canonicalOutputFor\(\)/);
  });

  it('rejects extractText that ignores its argument and returns a non-array', () => {
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeTextOutputFixtureStep({
          extractText: () => 'a generated reply',
        } as unknown as Partial<AnyBlockStep>)
      )
    ).toThrow(/extractText\(\) returned no text for canonicalOutputFor\(\)/);
  });

  it.each([
    ['an empty string', ''],
    ['whitespace only', '  \n\t '],
    ['a number', 42],
    ['null', null],
  ])('rejects extractText returning %s as an entry', (_label, value) => {
    // Whitespace is as vacuous as empty here for the same reason it is on the
    // input side — the scan filters blank text, so a whitespace-only "output"
    // would be scanned by nothing while the entry reports coverage.
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeTextOutputFixtureStep({
          extractText: () => [value],
        } as unknown as Partial<AnyBlockStep>)
      )
    ).toThrow(/extractText\(\) returned a non-string or empty entry/);
  });

  it('accepts extractText returning SEVERAL non-empty strings', () => {
    // The negative control for the clause above: it must reject unusable
    // entries, not multi-piece output.
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeTextOutputFixtureStep({
          extractText: () => ['first piece', 'second piece'],
        } as Partial<AnyBlockStep>)
      )
    ).not.toThrow();
  });

  // ── 🔴 THE OUTPUT SHAPE IS MEDIA **XOR** TEXT (clause 8, posture-gated) ─────
  //
  // 🔴 THE DEFECT THESE PIN, BOTH HALVES OF IT. Clause 8 used to demand ≥1 media
  // item with a non-empty `url` from EVERY entry with no posture gate — while
  // `ACCEPTABLE_POSTURES_BY_TYPE` licenses `'textOutput'` only for
  // TEXT-producing `$type`s. So:
  //   (a) an honest `chatCompletion` + `'textOutput'` entry COULD NOT REGISTER,
  //       and
  //   (b) the workaround it pushed an author toward — prose in a fabricated
  //       `media.url` — DID register and shipped that prose unscanned, because
  //       `StepOutputMedia.url` is a bare string that reaches
  //       `snapshot.imageUrls` / `AppWorkflow.images[].url` without ever meeting
  //       `attachModeratedStepTextOutputs`.
  // Both directions were reproduced by execution before the fix. (a) is pinned
  // by the two adoptability tests, (b) by the two rejection tests.

  it('🔴 ADOPTABILITY: a text entry registers with NO extractOutput and NO media at all', () => {
    // The claim (a) above, stated as the property that failed: an entry whose
    // canonical output carries text and NOTHING image-shaped is registrable.
    const step = makeTextOutputFixtureStep();
    expect(step.extractOutput, 'the fixture must not carry a media extractor').toBeUndefined();
    expect(
      JSON.stringify(step.canonicalOutputFor('default')),
      'the canonical output must carry no blob — a chatCompletion step returns none'
    ).not.toContain('blob');
    expect(() => assertStepInvariants('fixture-step', step)).not.toThrow();
  });

  it('🔴 ADOPTABILITY, the pre-fix shape: the SAME entry with a media extractor is now REJECTED', () => {
    // The negative control for the test above, and the reachability proof for
    // clause 8-ii. Only `extractOutput` differs between the two.
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeTextOutputFixtureStep({
          extractOutput: () => [
            { url: 'https://blobs.example/f.webp', width: null, height: null, nsfwLevel: null },
          ],
        } as unknown as Partial<AnyBlockStep>)
      )
    ).toThrow(/declares extractOutput\(\) but moderationPosture 'textOutput' publishes TEXT/);
  });

  it('🔴 THE SMUGGLE, CONCRETELY: prose in media.url on a text entry is rejected by clause 8-ii', () => {
    // 🔴 THE EXACT SHAPE THE AUDIT DEMONSTRATED. Nothing validates `media.url`
    // as a url, and this value reaches a block through `imageUrls` /
    // `images[].url`, neither of which passes the output scan. The rejection
    // must name the SMUGGLING clause — if it came from clause 8's "no media" or
    // "media with no url" branch instead, a text entry could still ship a media
    // extractor as long as it returned something url-shaped.
    const prose = 'Sure — here is how you would go about that. First, ';
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeTextOutputFixtureStep({
          extractOutput: () => [{ url: prose, width: null, height: null, nsfwLevel: null }],
        } as unknown as Partial<AnyBlockStep>)
      )
    ).toThrow(/media extractor on a text step is an unscanned channel to the block/);
  });

  it('rejects a MEDIA-posture entry that declares NO extractOutput — a NAMED error, not a TypeError', () => {
    // The other half of the XOR. Making `extractOutput` conditional must not
    // make it OPTIONAL for a media entry: without it the step is charged for,
    // reaches `succeeded`, and its result is unreachable on both read surfaces —
    // the exact inert-capability failure clause 8 was added for. And the error
    // has to be this clause's, not `step.extractOutput is not a function`.
    const step = makeFixtureStep();
    delete (step as { extractOutput?: unknown }).extractOutput;
    expect(() => assertStepInvariants('fixture-step', step)).toThrow(
      /publishes MEDIA and requires an extractOutput\(\) declaration/
    );
  });

  it('NEGATIVE CONTROL: the same media fixture WITH its extractOutput passes', () => {
    // Only the deleted field differs from the test above.
    expect(() => assertStepInvariants('fixture-step', makeFixtureStep())).not.toThrow();
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
// `resolveStepVariant` — the REQUEST-TIME bound on the resolved variant.
//
// 🔴 WHAT THESE TESTS ARE. The fixture here is the shape a MODEL-ALLOWLISTED
// entry would have: `resolveVariant` derives the variant from a param instead of
// returning a constant. No registered entry has that shape today
// (`convert-image` returns `() => 'default'`), so these are NOT regression
// coverage for a live bug — they pin a guard against a shape that arrives with
// the next entry. Labelled here rather than left to read as coverage of the
// shipped population.
//
// 🔴 WHAT WAS MEASURED ON UNMODIFIED `main`, and why the guard is worth its
// keep. With this exact fixture, `planStepSpend(entry, { model: <not
// declared> })` returned `reserveBuzz: undefined`. The router then computes
// `Math.ceil(undefined)` → `NaN`, and its per-call gate `reserveBuzz >
// claims.buzzBudget` evaluates **false** for `NaN` — i.e. the budget gate lets
// it through. That sequence was executed, not reasoned about.
// ─────────────────────────────────────────────────────────────────────────────
describe('block step registry — resolveStepVariant bounds the resolved variant', () => {
  /** Params-derived variant: the model-allowlist shape. */
  type ModelParams = { model: string };
  const DECLARED = ['model-a', 'model-b'] as const;
  const PRICES: Record<string, number> = { 'model-a': 3, 'model-b': 9 };

  function makeModelVariantStep(overrides: Partial<AnyBlockStep> = {}): AnyBlockStep {
    return makeFixtureStep({
      // 🔴 DELIBERATELY WIDER THAN `variants`. A correctly-written entry pins the
      // schema to the same set (`z.enum(DECLARED)`), which is what makes the
      // out-of-set case unreachable — the point of this fixture is that the
      // registry must not DEPEND on the entry having done that.
      paramSchema: z.object({ model: z.string() }).strict(),
      variants: [...DECLARED],
      resolveVariant: (p: ModelParams) => p.model,
      canonicalParamsFor: (v: string): ModelParams => ({ model: v }),
      priceForVariant: (v: string) => PRICES[v],
      estimateBuzz: (p: ModelParams) => PRICES[p.model],
      ...overrides,
    } as Partial<AnyBlockStep>);
  }

  // 🔴 THE NEGATIVE CONTROL. The fixture is valid and prices correctly for BOTH
  // declared variants — so every rejection below is caused by the one field the
  // test changes, not by the fixture being malformed.
  it('returns the resolved variant unchanged when it IS declared, and prices off it', () => {
    const step = makeModelVariantStep();
    expect(() => assertStepInvariants('fixture-step', step)).not.toThrow();
    for (const model of DECLARED) {
      const params = step.paramSchema.parse({ model });
      expect(resolveStepVariant(step, params)).toBe(model);
      expect(planStepSpend(step, params).reserveBuzz).toBe(PRICES[model]);
    }
  });

  it('REJECTS a resolution outside the declared variants, naming THIS guard', () => {
    const step = makeModelVariantStep();
    const rogue = step.paramSchema.parse({ model: 'model-not-declared' });
    let error: unknown;
    try {
      resolveStepVariant(step, rogue);
    } catch (e) {
      error = e;
    }
    // Pinned to this guard's own wording, so the test cannot pass because a
    // neighbouring guard threw first.
    expect(String(error)).toContain(
      "resolveVariant() returned 'model-not-declared', which is not one of the declared variants"
    );
    expect(String(error)).toContain('[model-a, model-b]');
    // NOT a billing-mode failure, NOT a load-time clause — the two nearest
    // neighbours on this path.
    expect(String(error)).not.toContain('has no money-path handler');
    expect(String(error)).not.toContain('canonicalParamsFor');
  });

  // 🔴 THE MONEY-PATH CONSEQUENCE, which is the reason the wrapper exists rather
  // than a lint. Before it, this call RETURNED `{ reserveBuzz: undefined }` and
  // the router's budget gate passed on the resulting `NaN` (see the block header
  // — measured). Now the same call throws, before any reservation exists.
  it('makes an out-of-set resolution a THROW on the spend path, not an undefined price', () => {
    const step = makeModelVariantStep();
    const rogue = step.paramSchema.parse({ model: 'model-not-declared' });
    expect(() => planStepSpend(step, rogue)).toThrow(/is not one of the declared variants/);

    // The precise thing that used to happen, pinned so a future refactor that
    // reintroduces it fails here: an unbounded variant reaching `priceForVariant`
    // yields `undefined`, whose `Math.ceil` is `NaN`, and `NaN > budget` is FALSE
    // — a budget gate that admits everything.
    expect(PRICES['model-not-declared']).toBeUndefined();
    expect(Math.ceil(undefined as unknown as number)).toBeNaN();
    expect(Math.ceil(undefined as unknown as number) > 1).toBe(false);
  });

  // The bound is on MEMBERSHIP in `variants` — nothing more. Stated as a test so
  // the limit is visible rather than inferred from the implementation.
  it('bounds membership only — it does not re-derive or second-guess the variant', () => {
    const step = makeModelVariantStep({
      // Ignores its params entirely and always answers with a DECLARED variant.
      resolveVariant: () => 'model-b',
    } as Partial<AnyBlockStep>);
    const params = step.paramSchema.parse({ model: 'model-a' });
    expect(resolveStepVariant(step, params)).toBe('model-b');
  });

  // 🔴 THE `NaN` HOLE IN A MEMBERSHIP CHECK. `Array.prototype.includes` uses
  // SameValueZero, under which `NaN` matches `NaN` — so `[NaN].includes(NaN)` is
  // `true` and a membership check ALONE would have admitted `NaN`, handing it to
  // `priceForVariant` and reopening the identical `undefined` → `Math.ceil` →
  // `NaN > budget === false` bypass. Latent, not live: TypeScript rejects the
  // entry below without the casts, exactly like the fail-open itself.
  it('REJECTS a non-string resolution that a membership check alone would ADMIT', () => {
    // The control, pinned rather than asserted in prose: this is why `includes`
    // is not sufficient on its own.
    expect([NaN].includes(NaN)).toBe(true);

    const step = makeModelVariantStep({
      variants: [NaN as unknown as string],
      resolveVariant: () => NaN as unknown as string,
    } as Partial<AnyBlockStep>);
    const params = step.paramSchema.parse({ model: 'model-a' });

    let error: unknown;
    try {
      resolveStepVariant(step, params);
    } catch (e) {
      error = e;
    }
    // Pinned to the TYPE guard's own wording — not the membership guard's, which
    // would not have fired at all, and not a neighbour's.
    expect(String(error)).toContain('resolveVariant() returned a non-string (number: NaN)');
    expect(String(error)).not.toContain('is not one of the declared variants');
    expect(String(error)).not.toContain('has no money-path handler');

    // And it is a THROW on the money path, not a `NaN` price.
    expect(() => planStepSpend(step, params)).toThrow(/returned a non-string/);
  });

  // 🔴 THE NEGATIVE CONTROL FOR THE TYPE GUARD. Same fixture shape, same casts,
  // only the resolved VALUE changes — a declared string sails through. So the
  // rejection above is caused by the resolution's type and by nothing else about
  // that fixture.
  it('admits a declared STRING through the same fixture shape the non-string test uses', () => {
    const step = makeModelVariantStep({
      variants: ['model-a' as unknown as string],
      resolveVariant: () => 'model-a' as unknown as string,
    } as Partial<AnyBlockStep>);
    const params = step.paramSchema.parse({ model: 'model-a' });
    expect(resolveStepVariant(step, params)).toBe('model-a');
    expect(planStepSpend(step, params).reserveBuzz).toBe(PRICES['model-a']);
  });

  // 🔴 THE ESTIMATE PATH IS BOUND BY THE SAME WRAPPER — the fix for an
  // estimate/submit split. `estimateBuzz` never receives the variant (it is
  // computed from params), so before the dispatcher resolved it this call
  // returned `PRICES['model-not-declared']` = `undefined`, i.e. the router's
  // estimate answered HTTP 200 with `cost: { total: undefined }` for input the
  // submit rejected. Both throw now, with the same message.
  it('fails IDENTICALLY on estimate and on submit for an out-of-set resolution', () => {
    const step = makeModelVariantStep();
    const rogue = step.paramSchema.parse({ model: 'model-not-declared' });

    // The pre-fix estimate value, pinned so a regression is visible as a value
    // and not only as a missing throw.
    expect(step.estimateBuzz(rogue)).toBeUndefined();

    expect(() => estimateStepBuzz(step, rogue)).toThrow(/is not one of the declared variants/);
    expect(() => planStepSpend(step, rogue)).toThrow(/is not one of the declared variants/);
    // And still agree, on a declared variant.
    const ok = step.paramSchema.parse({ model: 'model-b' });
    expect(estimateStepBuzz(step, ok)).toBe(PRICES['model-b']);
    expect(planStepSpend(step, ok).reserveBuzz).toBe(PRICES['model-b']);
  });

  // 🔴 THE BOUND LIVES IN THE DISPATCHER, NOT IN A HANDLER — which is what stops
  // a future mode from reopening the hole. A `tokenMetered` fixture has NO
  // money-path handler at all, so if the resolution happened inside a handler
  // this would die with "has no money-path handler". It dies with the VARIANT
  // error instead: every mode passes through the bound before its handler is
  // reached, including the modes nobody has written yet.
  it('bounds the variant BEFORE billing-mode dispatch, for a mode with no handler', () => {
    const step = makeModelVariantStep({
      billingMode: 'tokenMetered',
      maxBuzzForVariant: () => 500,
    } as Partial<AnyBlockStep>);
    const rogue = step.paramSchema.parse({ model: 'model-not-declared' });
    let error: unknown;
    try {
      planStepSpend(step, rogue);
    } catch (e) {
      error = e;
    }
    expect(String(error)).toContain('is not one of the declared variants');
    expect(String(error)).not.toContain('has no money-path handler');
  });

  // 🔴 THE THREADED DERIVATION IS THE ONE THAT PRICES. `submitStepWorkflow`
  // resolves the variant ONCE and passes it down; this pins that the passed value
  // is what `priceForVariant` receives, rather than the handler quietly
  // re-resolving from params. The fixture is chosen so the two DISAGREE — params
  // say `model-a` (3), the threaded variant says `model-b` (9) — so a
  // re-resolution scores 3 and cannot pass.
  it('prices off the THREADED variant, not a re-resolution from params', () => {
    const step = makeModelVariantStep();
    const params = step.paramSchema.parse({ model: 'model-a' });
    const threaded = resolveStepVariant(
      makeModelVariantStep({ resolveVariant: () => 'model-b' } as Partial<AnyBlockStep>),
      params
    );
    expect(threaded).toBe('model-b');
    expect(PRICES['model-a']).not.toBe(PRICES['model-b']);
    expect(planStepSpend(step, params, threaded).reserveBuzz).toBe(PRICES['model-b']);
    // Omitted → resolved from params, the default path the tests above exercise.
    expect(planStepSpend(step, params).reserveBuzz).toBe(PRICES['model-a']);
  });

  // 🔴 BEHAVIOUR-NEUTRALITY FOR THE SHIPPED POPULATION, executed rather than
  // argued. The bound and the hoist are a refactor on a live money path, so the
  // question that matters is not "does the guard work" (above) but "does any
  // REGISTERED entry now answer differently". The pre-change expressions are
  // written out literally on the left and compared against what the current
  // pipeline returns — for every registered entry and every declared variant, so
  // an entry added tomorrow is covered by this test today.
  //
  // Scope, stated at what was measured: this is the REGISTRY level with each
  // variant's canonical params. The REQUEST level — real, non-canonical params
  // through `submitWorkflow` — is covered by the step suite in
  // `blocks.router.workflow.test.ts`, which drives the same entry end to end.
  it('is behaviour-NEUTRAL over the registered population: no value changes', () => {
    const entries = listRegisteredSteps();
    // Positive control for this loop: a population of zero would make every
    // assertion below vacuously true and the test would still be green.
    expect(entries.length).toBeGreaterThan(0);
    let checked = 0;
    for (const [id, step] of entries) {
      for (const declared of step.variants) {
        const params = step.paramSchema.parse(step.canonicalParamsFor(declared));
        // The exact expressions this change replaced.
        const legacyVariant = step.resolveVariant(params);
        const legacyEstimate = step.estimateBuzz(params);

        expect(resolveStepVariant(step, params), `step '${id}' variant`).toBe(legacyVariant);
        expect(estimateStepBuzz(step, params), `step '${id}' estimate`).toBe(legacyEstimate);

        if (step.billingMode === 'prepaidFixed') {
          const legacyReserve = step.priceForVariant(legacyVariant);
          expect(planStepSpend(step, params).reserveBuzz, `step '${id}' reserve`).toBe(
            legacyReserve
          );
          // And the THREADED call the router now makes is identical to the
          // un-threaded one it used to make — the hoist's whole claim.
          expect(planStepSpend(step, params, resolveStepVariant(step, params))).toEqual(
            planStepSpend(step, params)
          );
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
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

// ─────────────────────────────────────────────────────────────────────────────
// Clause 1b — posture ↔ orchestrator `$type` agreement.
//
// 🔴 WHY THIS BLOCK EXISTS AT ALL. Every other moderation clause checks the
// declared posture against ITSELF. This one is the only check that reads it
// against something the entry author did not also write, so it is the only one
// that can catch a `chatCompletion` entry declaring `'promptAudit'` — a
// declaration that audits the input and ships the output unscanned while
// passing clauses 1, 1a and 5a.
//
// Every rejection below is paired with a NEGATIVE CONTROL asserting the SAME
// fixture passes when only the `$type` changes, so each failure is provably the
// `$type` constraint rather than the fixture being broken some other way.
// ─────────────────────────────────────────────────────────────────────────────
describe('block step registry — posture ↔ orchestratorType agreement (clause 1b)', () => {
  it('REACHABILITY: a chatCompletion entry declaring promptAudit is rejected by THIS clause', () => {
    // The fixture is otherwise fully valid — it passes clause 1 (promptAudit IS
    // implemented) and clause 1a (auditableText is declared and non-empty), so
    // reaching this rejection proves no earlier clause wins first.
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeAuditedFixtureStep({ orchestratorType: 'chatCompletion' })
      )
    ).toThrow(/requires moderationPosture 'textOutput'.*declares 'promptAudit'/s);
  });

  it('NEGATIVE CONTROL: the identical fixture passes on an unconstrained $type', () => {
    expect(() => assertStepInvariants('fixture-step', makeAuditedFixtureStep())).not.toThrow();
  });

  it('rejects a text-producing $type declaring the no-surface posture', () => {
    for (const orchestratorType of ['chatCompletion', 'mediaCaptioning', 'transcription']) {
      expect(() =>
        assertStepInvariants('fixture-step', makeFixtureStep({ orchestratorType }))
      ).toThrow(/does not cover the moderation surface this step actually produces/);
    }
  });

  it('the HONEST declaration now REGISTERS — clause 1b does not stand in its way', () => {
    // `chatCompletion` + `'textOutput'` is the correct declaration, and with the
    // posture implemented it is a registrable entry rather than a load failure.
    // 🔴 This is the assertion that would catch `ACCEPTABLE_POSTURES_BY_TYPE`
    // being wrong about `chatCompletion`: before, a clause-1 rejection masked
    // whatever clause 1b thought, so 1b was never actually exercised for the
    // honest shape.
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeTextOutputFixtureStep({ orchestratorType: 'chatCompletion' })
      )
    ).not.toThrow();
  });

  it('an INCOMPLETE textOutput declaration reports the missing extractor, not a type mismatch', () => {
    // The author who declares the right posture on the right `$type` but forgets
    // the extractor must be told THAT — the ordering property the previous test
    // used to cover via clause 1.
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeFixtureStep({ orchestratorType: 'chatCompletion', moderationPosture: 'textOutput' })
      )
    ).toThrow(/requires an extractText\(\) declaration/);
  });

  it('rejects a text-producing $type declaring promptAudit — the input-only answer', () => {
    // The whole shape this clause exists for: auditing the input while the
    // output ships unscanned.
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeAuditedFixtureStep({ orchestratorType: 'promptEnhancement' })
      )
    ).toThrow(/requires moderationPosture 'textOutput'/);
  });

  it('EVERY entry is single-valued — the map must encode no posture subsumption', () => {
    // 🔴 Pins the inclusion criterion (free-text OUTPUT only). A multi-valued
    // entry would mean some type accepts two postures, which is the ladder
    // claim the map's own doc-comment disclaims — and it is exactly what a
    // `textToSpeech: ['promptAudit','textOutput']` entry did before review
    // caught it. If a future type genuinely needs two, that is a design
    // decision that must change the doc-comment, not slip in under this test.
    for (const [type, postures] of Object.entries(STEP_TYPE_ACCEPTABLE_POSTURES)) {
      expect(postures, `${type} is multi-valued`).toEqual(['textOutput']);
    }
  });

  it('the posture ARRAYS are frozen, not just the map — freeze is shallow', () => {
    // 🔴 Without freezing the values, `readonly` is compile-time-only and
    // `arr.push('none')` at runtime makes a chatCompletion entry declaring
    // 'none' register cleanly. Demonstrated by execution in review.
    for (const [type, postures] of Object.entries(STEP_TYPE_ACCEPTABLE_POSTURES)) {
      expect(Object.isFrozen(postures), `${type} postures not frozen`).toBe(true);
      expect(() => (postures as StepModerationPosture[]).push('none')).toThrow();
    }
    expect(Object.isFrozen(STEP_TYPE_ACCEPTABLE_POSTURES)).toBe(true);
  });

  it('every map KEY is a real orchestrator $type in the generated client', () => {
    // 🔴 `satisfies Record<string, …>` constrains the VALUES, not the keys — a
    // typo'd key (`chatCompletions`) compiles clean and constrains nothing,
    // silently covering no type at all. The generated client is the
    // authoritative enumeration; this is the only thing that can catch it.
    const generated = readFileSync(
      require.resolve('@civitai/client/dist/generated/types.gen.d.ts'),
      'utf8'
    );
    const declared = new Set(
      [...generated.matchAll(/\$type\??: '([A-Za-z0-9_]+)'/g)].map((m) => m[1])
    );
    // 🔴 A LOOSE FLOOR HERE IS THE WHOLE RISK: a regex that half-matches would
    // still clear a small threshold, and every key would still be found, so the
    // test would pass while observing a fraction of the enumeration. The real
    // count is ~43; 30 is tight enough that a half-broken regex fails loudly.
    expect(
      declared.size,
      'parsed too few $type literals — the regex or the generated file moved'
    ).toBeGreaterThan(30);
    for (const key of Object.keys(STEP_TYPE_ACCEPTABLE_POSTURES)) {
      expect(declared, `'${key}' is not a $type in the generated client`).toContain(key);
    }
  });

  it('a non-own key reads as UNCONSTRAINED, not as data (prototype seam)', () => {
    // A bare index would return `Object.prototype.toString` — truthy, and
    // `.includes` on a function would throw rather than fail closed.
    expect(acceptablePosturesFor('toString')).toBeUndefined();
    expect(acceptablePosturesFor('constructor')).toBeUndefined();
    expect(acceptablePosturesFor('__proto__')).toBeUndefined();
    expect(() =>
      assertStepInvariants('fixture-step', makeFixtureStep({ orchestratorType: 'toString' }))
    ).not.toThrow();
  });

  it('the map is NON-EMPTY and covers chatCompletion — emptying it silently disables the gate', () => {
    const keys = Object.keys(STEP_TYPE_ACCEPTABLE_POSTURES);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toContain('chatCompletion');
    // Every listed posture must be a DECLARED posture, or the constraint names
    // a value no entry could ever satisfy.
    for (const postures of Object.values(STEP_TYPE_ACCEPTABLE_POSTURES)) {
      expect(postures.length).toBeGreaterThan(0);
      for (const p of postures) expect(STEP_MODERATION_POSTURES).toContain(p);
    }
  });

  it('no constrained $type is natively extracted — that would make the constraint unreachable', () => {
    // Clause 9 rejects a natively-extracted `$type` outright, so listing one
    // here would be a constraint no entry could ever reach.
    for (const t of Object.keys(STEP_TYPE_ACCEPTABLE_POSTURES)) {
      expect(NATIVELY_EXTRACTED_STEP_TYPES).not.toContain(t);
    }
  });

  // 🔴 AN INVARIANT GUARD, NOT REGRESSION COVERAGE — labelled so nobody counts
  // it as the latter. Today the sole entry (`convertImage`) carries an
  // unconstrained `$type`, so the loop body `continue`s and this test survives
  // deleting clause 1b entirely. It earns its place only for the day a
  // constrained entry is registered.
  it('every SHIPPED entry satisfies the constraint for its own $type (vacuous today)', () => {
    for (const [id, step] of listRegisteredSteps()) {
      const acceptable = acceptablePosturesFor(step.orchestratorType);
      if (acceptable === undefined) continue;
      expect(acceptable, `${id} declares ${step.moderationPosture}`).toContain(
        step.moderationPosture
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Clause 7a — the declared `$type` must be the one `buildStep()` actually emits.
//
// 🔴 THIS IS WHAT MAKES CLAUSE 1b A CONTROL. `orchestratorType` is author-
// declared and the router submits `buildStep(...).$type`, so without 7a an
// entry declares a benign type, builds `chatCompletion`, and the posture
// constraint reads the wrong axis. Review demonstrated that bypass by
// execution before this clause existed.
// ─────────────────────────────────────────────────────────────────────────────
describe('block step registry — declared $type vs built $type (clause 7a)', () => {
  it('REACHABILITY: rejects an entry whose buildStep emits a DIFFERENT $type', () => {
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeFixtureStep({
          buildStep: () => ({ $type: 'somethingElse', input: {} }),
        })
      )
    ).toThrow(/declares orchestratorType 'fixtureType' but buildStep\(\) emits 'somethingElse'/);
  });

  it('THE BYPASS IT CLOSES: benign declared type + chatCompletion built type', () => {
    // Before 7a this registered cleanly with moderationPosture 'none' and the
    // router submitted a chatCompletion step.
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeFixtureStep({
          orchestratorType: 'fixtureType',
          moderationPosture: 'none',
          buildStep: () => ({ $type: 'chatCompletion', input: {} }),
        })
      )
    ).toThrow(/but buildStep\(\) emits 'chatCompletion'/);
  });

  it('also closes the clause-9 variant — declaring benign while building a native $type', () => {
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeFixtureStep({ buildStep: () => ({ $type: 'textToImage', input: {} }) })
      )
    ).toThrow(/but buildStep\(\) emits 'textToImage'/);
  });

  it('rejects a buildStep that returns a non-object — a NAMED error, not a TypeError', () => {
    // 🔴 `buildStep` now runs for EVERY entry (7a needs it), so a bad return
    // crashes module load for any entry. Both shapes fail closed; this pins the
    // guard so the failure carries a clause name instead of a bare
    // `TypeError: Cannot read properties of undefined`.
    expect(() =>
      assertStepInvariants(
        'fixture-step',
        makeFixtureStep({ buildStep: (() => undefined) as never })
      )
    ).toThrow(/buildStep\(\) must return an orchestrator step template/);
  });

  it('NEGATIVE CONTROL: an agreeing entry passes', () => {
    expect(() => assertStepInvariants('fixture-step', makeFixtureStep())).not.toThrow();
  });

  // 🔴 REDUNDANT WITH THE LOAD-TIME GATE, labelled rather than left to look
  // like independent coverage: `assertStepInvariants` runs at module import, so
  // an entry violating 7a crashes the import before this test can collect. It
  // documents the invariant; it cannot independently fail.
  it('every SHIPPED entry agrees, on every variant (redundant with load-time gate)', () => {
    for (const [id, step] of listRegisteredSteps()) {
      for (const variant of step.variants) {
        const params = step.paramSchema.parse(step.canonicalParamsFor(variant));
        expect(step.buildStep(params).$type, `${id} variant '${variant}'`).toBe(
          step.orchestratorType
        );
      }
    }
  });
});
