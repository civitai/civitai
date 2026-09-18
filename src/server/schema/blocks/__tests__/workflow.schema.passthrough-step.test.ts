import { describe, expect, it } from 'vitest';
import {
  blockPassThroughStepBodySchema,
  blockStepBodySchema,
  blockWorkflowBodySchema,
  PASS_THROUGH_INPUT_BYTES_MAX,
  PASS_THROUGH_MAX_BUZZ,
} from '~/server/schema/blocks/workflow.schema';
import { REGISTERED_STEP_IDS } from '~/server/services/blocks/steps';
import { PLATFORM_INTERNAL_STEP_TYPES } from '~/server/services/blocks/steps/orchestrator-denylist';

/**
 * Wire-contract coverage for the PASS-THROUGH arm of `kind: 'step'` — the body
 * that names an orchestrator `$type` directly instead of a registered id.
 *
 * The properties that are expensive to get wrong, because `@civitai/app-sdk`
 * mirrors this shape and both arms share one discriminant:
 *   1. an UNREGISTERED `$type` parses — that is the whole feature
 *   2. the registry arm is untouched, including its `path:['step']` rejection
 *   3. `input` survives the parse byte-identically
 */

const REGISTERED_ID = REGISTERED_STEP_IDS[0];

/**
 * A `$type` the LIVE orchestrator has and the step registry does not — measured
 * against `WorkflowStepTemplate.discriminator.mapping` (50 entries on
 * 2026-09-17), not invented. `textToImageV2` reads like a step type and is not
 * in that mapping.
 */
const UNREGISTERED_TYPE = 'imageBackgroundRemoval';

function passThroughBody(over: Record<string, unknown> = {}) {
  return { kind: 'step', $type: UNREGISTERED_TYPE, input: {}, maxBuzz: 10, ...over };
}

describe("blockWorkflowBodySchema — kind: 'step' PASS-THROUGH arm", () => {
  it('accepts a $type that is NOT in the step registry', () => {
    expect(REGISTERED_STEP_IDS).not.toContain(UNREGISTERED_TYPE);
    const parsed = blockWorkflowBodySchema.safeParse(passThroughBody());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toMatchObject({
      kind: 'step',
      $type: UNREGISTERED_TYPE,
      maxBuzz: 10,
    });
  });

  // 🔴 THE WIRE DOES NOT ENFORCE THE DENYLIST — the ROUTER does, on the submitted
  // `$type`, before any spend. Pinned here so nobody reads a schema-level
  // rejection into this arm and then "simplifies" the router check away: every
  // denylisted type PARSES, and is refused one layer down.
  it('parses a PLATFORM-INTERNAL $type — the denylist is a router gate, not a wire gate', () => {
    for (const denied of PLATFORM_INTERNAL_STEP_TYPES) {
      expect(blockWorkflowBodySchema.safeParse(passThroughBody({ $type: denied })).success).toBe(
        true
      );
    }
  });

  it('forwards a non-trivial nested input UNMODIFIED through the parse', () => {
    const input = {
      prompt: 'a cat',
      nested: { list: [1, 2, { deep: 'value', nullish: null }], flag: false },
      emptyObj: {},
      emptyList: [],
    };
    const parsed = blockWorkflowBodySchema.safeParse(passThroughBody({ input }));
    expect(parsed.success).toBe(true);
    // Byte-equality, not deep-equality — a coerced number or a dropped key would
    // survive `toEqual` on a loose comparison but not this.
    expect(JSON.stringify(parsed.success && (parsed.data as { input: unknown }).input)).toBe(
      JSON.stringify(input)
    );
  });

  it('REJECTS an unknown top-level field (.strict())', () => {
    expect(blockWorkflowBodySchema.safeParse(passThroughBody({ surprise: 1 })).success).toBe(false);
  });

  it('REJECTS a body naming BOTH arms at once', () => {
    expect(
      blockWorkflowBodySchema.safeParse(passThroughBody({ step: REGISTERED_ID, params: {} }))
        .success
    ).toBe(false);
  });

  it('REJECTS a missing $type / input / maxBuzz', () => {
    expect(blockWorkflowBodySchema.safeParse({ kind: 'step', input: {}, maxBuzz: 1 }).success).toBe(
      false
    );
    expect(
      blockWorkflowBodySchema.safeParse({ kind: 'step', $type: UNREGISTERED_TYPE, maxBuzz: 1 })
        .success
    ).toBe(false);
    expect(
      blockWorkflowBodySchema.safeParse({ kind: 'step', $type: UNREGISTERED_TYPE, input: {} })
        .success
    ).toBe(false);
  });

  describe('maxBuzz is the only spend knob, and it is bounded', () => {
    it.each([0, -1, 1.5, PASS_THROUGH_MAX_BUZZ + 1])('REJECTS maxBuzz %s', (maxBuzz) => {
      expect(blockWorkflowBodySchema.safeParse(passThroughBody({ maxBuzz })).success).toBe(false);
    });

    it('accepts the boundary', () => {
      expect(blockWorkflowBodySchema.safeParse(passThroughBody({ maxBuzz: 1 })).success).toBe(true);
      expect(
        blockWorkflowBodySchema.safeParse(passThroughBody({ maxBuzz: PASS_THROUGH_MAX_BUZZ }))
          .success
      ).toBe(true);
    });
  });

  it('REJECTS an empty or over-long $type', () => {
    expect(blockWorkflowBodySchema.safeParse(passThroughBody({ $type: '' })).success).toBe(false);
    expect(
      blockWorkflowBodySchema.safeParse(passThroughBody({ $type: 'x'.repeat(65) })).success
    ).toBe(false);
    // The longest real orchestrator type name is 22 chars
    // (`imageBackgroundRemoval`, measured 2026-09-17), so the bound clears the
    // catalog with room — this asserts the bound is above it, not at it.
    expect(
      blockWorkflowBodySchema.safeParse(passThroughBody({ $type: 'x'.repeat(64) })).success
    ).toBe(true);
  });

  it('REJECTS an input over the payload bound', () => {
    const big = { pad: 'x'.repeat(PASS_THROUGH_INPUT_BYTES_MAX) };
    expect(JSON.stringify(big).length).toBeGreaterThan(PASS_THROUGH_INPUT_BYTES_MAX);
    const parsed = blockWorkflowBodySchema.safeParse(passThroughBody({ input: big }));
    expect(parsed.success).toBe(false);
    expect(
      parsed.success === false && parsed.error.issues.some((i) => i.path.includes('input'))
    ).toBe(true);
  });

  // 🔴 THE ARM DISCRIMINATOR IS THE VALUE OF `step`, NOT THE ABSENCE OF THE KEY.
  // An SDK that spreads an optional variable sends `step: undefined` as an OWN
  // key and `undefined` survives superjson, so this body is reachable in
  // production. It must land on the pass-through arm, not be rejected.
  it('an EXPLICIT `step: undefined` still lands on the pass-through arm', () => {
    const parsed = blockWorkflowBodySchema.safeParse(passThroughBody({ step: undefined }));
    expect(parsed.success).toBe(true);
    expect(parsed.success && (parsed.data as { $type: string }).$type).toBe(UNREGISTERED_TYPE);
  });
});

describe("kind: 'step' — the REGISTRY arm is unchanged by the new sibling", () => {
  it('a registered id + params still parses', () => {
    expect(
      blockWorkflowBodySchema.safeParse({ kind: 'step', step: REGISTERED_ID, params: { a: 1 } })
        .success
    ).toBe(true);
  });

  // The error PATH is the contract `workflow.schema.step.test.ts` pins, and a
  // nested union is exactly the change that could have moved it to `path: []`.
  it('an unregistered step id is still rejected AT `path: ["step"]`', () => {
    const parsed = blockWorkflowBodySchema.safeParse({
      kind: 'step',
      step: 'not-a-registered-step',
      params: {},
    });
    expect(parsed.success).toBe(false);
    expect(
      parsed.success === false && parsed.error.issues.some((i) => i.path.includes('step'))
    ).toBe(true);
  });

  it('the exported registry-arm schema still refuses a pass-through body on its own', () => {
    expect(blockStepBodySchema.safeParse(passThroughBody()).success).toBe(false);
    expect(blockPassThroughStepBodySchema.safeParse(passThroughBody()).success).toBe(true);
  });
});
