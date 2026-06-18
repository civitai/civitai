import { describe, expect, it } from 'vitest';

import {
  blockWorkflowBodySchema,
  LORA_STRENGTH_MAX,
  LORA_STRENGTH_MIN,
  MAX_ADDITIONAL_RESOURCES,
} from '../workflow.schema';

/**
 * Page-LoRA (Increment 1) — body-schema coverage. The block body runs in an
 * untrusted iframe, so the additionalResources array caps (count, strength,
 * positive version id) are enforced at the boundary. These tests lock the
 * cap geometry so a future loosening is caught.
 */

const baseBody = (over: Record<string, unknown> = {}) => ({
  kind: 'textToImage' as const,
  modelId: 7,
  modelVersionId: 99,
  params: { prompt: 'a cat', quantity: 1 },
  ...over,
});

describe('blockWorkflowBodySchema — additionalResources (Page-LoRA)', () => {
  it('parses a body with NO additionalResources (field is optional)', () => {
    const parsed = blockWorkflowBodySchema.parse(baseBody());
    expect(parsed.kind).toBe('textToImage');
    // Optional + absent → stays undefined (not coerced to []).
    expect((parsed as { additionalResources?: unknown }).additionalResources).toBeUndefined();
  });

  it('parses up to MAX_ADDITIONAL_RESOURCES LoRA entries', () => {
    const resources = Array.from({ length: MAX_ADDITIONAL_RESOURCES }, (_, i) => ({
      modelVersionId: 1000 + i,
      strength: 1,
    }));
    const parsed = blockWorkflowBodySchema.parse(baseBody({ additionalResources: resources }));
    expect((parsed as any).additionalResources).toHaveLength(MAX_ADDITIONAL_RESOURCES);
  });

  it('REJECTS more than MAX_ADDITIONAL_RESOURCES entries', () => {
    const resources = Array.from({ length: MAX_ADDITIONAL_RESOURCES + 1 }, (_, i) => ({
      modelVersionId: 1000 + i,
      strength: 1,
    }));
    expect(() =>
      blockWorkflowBodySchema.parse(baseBody({ additionalResources: resources }))
    ).toThrow();
  });

  it('defaults strength to 1 when omitted', () => {
    const parsed = blockWorkflowBodySchema.parse(
      baseBody({ additionalResources: [{ modelVersionId: 1234 }] })
    );
    expect((parsed as any).additionalResources[0].strength).toBe(1);
  });

  it('accepts strength at the inclusive bounds [MIN, MAX]', () => {
    const parsed = blockWorkflowBodySchema.parse(
      baseBody({
        additionalResources: [
          { modelVersionId: 1, strength: LORA_STRENGTH_MIN },
          { modelVersionId: 2, strength: LORA_STRENGTH_MAX },
        ],
      })
    );
    expect((parsed as any).additionalResources[0].strength).toBe(LORA_STRENGTH_MIN);
    expect((parsed as any).additionalResources[1].strength).toBe(LORA_STRENGTH_MAX);
  });

  it('REJECTS strength below the minimum', () => {
    expect(() =>
      blockWorkflowBodySchema.parse(
        baseBody({ additionalResources: [{ modelVersionId: 1, strength: LORA_STRENGTH_MIN - 0.1 }] })
      )
    ).toThrow();
  });

  it('REJECTS strength above the maximum', () => {
    expect(() =>
      blockWorkflowBodySchema.parse(
        baseBody({ additionalResources: [{ modelVersionId: 1, strength: LORA_STRENGTH_MAX + 0.1 }] })
      )
    ).toThrow();
  });

  it('REJECTS a non-positive modelVersionId', () => {
    expect(() =>
      blockWorkflowBodySchema.parse(
        baseBody({ additionalResources: [{ modelVersionId: 0, strength: 1 }] })
      )
    ).toThrow();
    expect(() =>
      blockWorkflowBodySchema.parse(
        baseBody({ additionalResources: [{ modelVersionId: -5, strength: 1 }] })
      )
    ).toThrow();
  });

  it('REJECTS a non-integer modelVersionId', () => {
    expect(() =>
      blockWorkflowBodySchema.parse(
        baseBody({ additionalResources: [{ modelVersionId: 12.5, strength: 1 }] })
      )
    ).toThrow();
  });
});
