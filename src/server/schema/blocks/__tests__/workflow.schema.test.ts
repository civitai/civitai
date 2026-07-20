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

  // LOW-1: strength is strict (non-coerced) parity with modelVersionId. Block
  // bodies are JSON so a real number always arrives; z.coerce previously let
  // ""/[]/true/null slip to 0/1 instead of being rejected.
  it('REJECTS a non-number strength ("", [], true, null) instead of coercing', () => {
    for (const bad of ['', [], true, null]) {
      expect(() =>
        blockWorkflowBodySchema.parse(
          baseBody({ additionalResources: [{ modelVersionId: 1, strength: bad }] })
        )
      ).toThrow();
    }
  });

  it('still accepts a real in-range number for strength', () => {
    const parsed = blockWorkflowBodySchema.parse(
      baseBody({ additionalResources: [{ modelVersionId: 1, strength: 0.65 }] })
    );
    expect((parsed as any).additionalResources[0].strength).toBe(0.65);
  });

  it('still applies the default (1) when strength is omitted', () => {
    const parsed = blockWorkflowBodySchema.parse(
      baseBody({ additionalResources: [{ modelVersionId: 1 }] })
    );
    expect((parsed as any).additionalResources[0].strength).toBe(1);
  });
});

/**
 * G5 — generic published-content-author key. Opaque, optional, bounded to the
 * shared-storage key shape (≤64). The server resolves the author from it; the
 * wire schema only bounds shape.
 */
describe('blockWorkflowBodySchema — sharedContentKey (G5)', () => {
  it('is optional — a body without it parses (field stays undefined)', () => {
    const parsed = blockWorkflowBodySchema.parse(baseBody());
    expect((parsed as { sharedContentKey?: unknown }).sharedContentKey).toBeUndefined();
  });

  it('accepts a bounded opaque key', () => {
    const parsed = blockWorkflowBodySchema.parse(baseBody({ sharedContentKey: 'k_01ABCDEF' }));
    expect((parsed as { sharedContentKey?: string }).sharedContentKey).toBe('k_01ABCDEF');
  });

  it('rejects an over-long key (> 64 chars)', () => {
    expect(() =>
      blockWorkflowBodySchema.parse(baseBody({ sharedContentKey: 'k'.repeat(65) }))
    ).toThrow();
  });

  it('rejects an empty key', () => {
    expect(() => blockWorkflowBodySchema.parse(baseBody({ sharedContentKey: '' }))).toThrow();
  });

  it('rejects a non-string key', () => {
    expect(() => blockWorkflowBodySchema.parse(baseBody({ sharedContentKey: 123 }))).toThrow();
  });
});

/**
 * img2img sourceImage host allowlist (blockSourceImageSchema).
 *
 * The `generationSource` block-upload mode returns an orchestrator consumer-blob
 * URL (`https://orchestration…civitai.com/v2/consumer/blobs/…`) — the SAME host
 * the generator's own SourceImageUpload yields. This locks in that such a URL
 * PASSES the existing allowlist unchanged (hostname ends in `.civitai.com`), so
 * no loosening was required, while attacker-controlled / non-https / host-
 * confusion URLs are still rejected.
 */
describe('blockWorkflowBodySchema — sourceImage host allowlist (generationSource reconciliation)', () => {
  const withSource = (url: string) =>
    blockWorkflowBodySchema.parse(baseBody({ sourceImage: { url, width: 512, height: 512 } }));

  it('accepts the orchestrator consumer-blob URL that generationSource yields', () => {
    // Representative of uploadConsumerBlob's result (see SourceImageUpload).
    const parsed = withSource(
      'https://orchestration.civitai.com/v2/consumer/blobs/CXJQSCS1TYZR1PX45C7QBVB8E0.jpeg?sig=abc&exp=2030-01-01T00:00:00Z'
    );
    expect((parsed as { sourceImage?: { url: string } }).sourceImage?.url).toContain(
      'orchestration.civitai.com'
    );
  });

  it('accepts the orchestration-new subdomain variant (hostname still ends in .civitai.com)', () => {
    expect(() =>
      withSource('https://orchestration-new.civitai.com/v2/consumer/blobs/E8S6FBPH50ENNVF2PD5.jpeg')
    ).not.toThrow();
  });

  it('REJECTS a host-confusion URL that merely contains the allowed host as a substring', () => {
    expect(() =>
      withSource('https://evil.example/?x=orchestration.civitai.com/blob.jpeg')
    ).toThrow();
  });

  it('REJECTS a non-https orchestrator URL', () => {
    expect(() =>
      withSource('http://orchestration.civitai.com/v2/consumer/blobs/abc.jpeg')
    ).toThrow();
  });
});
