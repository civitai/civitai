import { describe, expect, it } from 'vitest';
import {
  blockStepBodySchema,
  blockWorkflowBodySchema,
  makeBlockStepBodySchema,
} from '~/server/schema/blocks/workflow.schema';
import { REGISTERED_STEP_IDS } from '~/server/services/blocks/steps';

/**
 * Wire-contract coverage for the THIRD discriminated-union member,
 * `kind: 'step'` (RFC #3515 migration step 1).
 *
 * The properties under test are the ones that are expensive to get wrong,
 * because `@civitai/app-sdk` mirrors this shape and every published app ships
 * against it:
 *   1. an unregistered step id fails closed AT THE SCHEMA, not deeper in the stack
 *   2. the id enum is DERIVED from the registry keys, not hardcoded
 *   3. adding the member did not change how the existing two members parse
 */

const VALID_STEP_ID = REGISTERED_STEP_IDS[0];

describe("blockWorkflowBodySchema — kind: 'step'", () => {
  it('accepts a registered step id with opaque params', () => {
    const parsed = blockWorkflowBodySchema.safeParse({
      kind: 'step',
      step: VALID_STEP_ID,
      params: { image: 'https://image.civitai.com/x.png', output: { format: 'webp' } },
    });
    expect(parsed.success).toBe(true);
  });

  // 🔴 FAIL CLOSED AT THE SCHEMA. Not in the handler, not at the orchestrator —
  // an unregistered id must never reach a translator or a spend reservation.
  it('REJECTS an unregistered step id at the wire schema', () => {
    const parsed = blockWorkflowBodySchema.safeParse({
      kind: 'step',
      step: 'not-a-registered-step',
      params: {},
    });
    expect(parsed.success).toBe(false);
    // The failure is on the `step` field specifically — i.e. the enum rejected
    // it, not some unrelated shape check.
    expect(
      parsed.success === false && parsed.error.issues.some((i) => i.path.includes('step'))
    ).toBe(true);
  });

  it('REJECTS an unknown top-level field (.strict())', () => {
    const parsed = blockWorkflowBodySchema.safeParse({
      kind: 'step',
      step: VALID_STEP_ID,
      params: {},
      surpriseField: 1,
    });
    expect(parsed.success).toBe(false);
  });

  it('REJECTS a missing step id and a missing params object', () => {
    expect(blockWorkflowBodySchema.safeParse({ kind: 'step', params: {} }).success).toBe(false);
    expect(blockWorkflowBodySchema.safeParse({ kind: 'step', step: VALID_STEP_ID }).success).toBe(
      false
    );
  });

  // 🔴 DERIVATION, proven rather than asserted. The enum is built by a factory
  // over an id list, so widening the list widens the enum — which is what makes
  // "register a step, no schema surgery" true. A hardcoded enum would pass every
  // other test in this file and fail this one.
  it('derives its id enum from the registry keys — a widened list widens the enum', () => {
    const widened = makeBlockStepBodySchema([...REGISTERED_STEP_IDS, 'fixture-only-step']);

    // The shipped schema rejects the fixture id...
    expect(
      blockStepBodySchema.safeParse({ kind: 'step', step: 'fixture-only-step', params: {} }).success
    ).toBe(false);
    // ...and the same factory over a widened list accepts it, with no other change.
    expect(widened.safeParse({ kind: 'step', step: 'fixture-only-step', params: {} }).success).toBe(
      true
    );
    // Every real id still parses under both.
    for (const id of REGISTERED_STEP_IDS) {
      expect(blockStepBodySchema.safeParse({ kind: 'step', step: id, params: {} }).success).toBe(
        true
      );
      expect(widened.safeParse({ kind: 'step', step: id, params: {} }).success).toBe(true);
    }
  });
});

describe('blockWorkflowBodySchema — the existing members are unchanged', () => {
  // Adding a union member must be purely additive. These pin the two shapes that
  // are already public; a regression here breaks every deployed block.
  const textToImageBody = {
    kind: 'textToImage' as const,
    modelId: 123,
    modelVersionId: 456,
    params: { prompt: 'a cat', quantity: 1 },
  };

  it('textToImage still parses and still produces the same normalized body', () => {
    const parsed = blockWorkflowBodySchema.safeParse(textToImageBody);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({
      kind: 'textToImage',
      modelId: 123,
      modelVersionId: 456,
      params: { prompt: 'a cat', quantity: 1 },
    });
  });

  it('textToImage still canonicalizes a sourceImage URL and still rejects a non-Civitai host', () => {
    // The Civitai-host predicate MOVED to its own module in this change; these
    // pin that the behaviour did not move with it.
    const ok = blockWorkflowBodySchema.safeParse({
      ...textToImageBody,
      sourceImage: { url: 'https://image.civitai.com/abc.png', width: 512, height: 512 },
    });
    expect(ok.success).toBe(true);
    expect(ok.success && (ok.data as { sourceImage: { url: string } }).sourceImage.url).toBe(
      'https://image.civitai.com/abc.png'
    );

    const evil = blockWorkflowBodySchema.safeParse({
      ...textToImageBody,
      sourceImage: { url: 'https://evil.example/?x=image.civitai.com', width: 512, height: 512 },
    });
    expect(evil.success).toBe(false);
  });

  it('customComfy still parses and still rejects an unregistered recipe', () => {
    const ok = blockWorkflowBodySchema.safeParse({
      kind: 'customComfy',
      recipe: 'seamless-pano-360',
      params: { prompt: 'x' },
    });
    expect(ok.success).toBe(true);

    const bad = blockWorkflowBodySchema.safeParse({
      kind: 'customComfy',
      recipe: 'not-a-recipe',
      params: {},
    });
    expect(bad.success).toBe(false);
  });

  it('an unknown kind is still rejected', () => {
    expect(
      blockWorkflowBodySchema.safeParse({ kind: 'chatCompletion', model: 'x', messages: [] })
        .success
    ).toBe(false);
  });
});
