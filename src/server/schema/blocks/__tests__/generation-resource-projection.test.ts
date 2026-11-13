import { describe, it, expect } from 'vitest';
import {
  projectSafeGenerationResource,
  type ProjectableGenerationResource,
} from '~/server/schema/blocks/generation-resource-projection';

/**
 * App Blocks (Phase-2a PR-C) — the canonical safe projection shared by the widened
 * OPEN_RESOURCE_PICKER result AND the generation-resources rehydrate endpoint.
 * Proves the WIDENED public fields are carried and internals never are.
 */

// A resource shaped like a full GenerationResource with the private internals a
// picker onSelect / getResourceData row actually carries — to prove they are NOT
// projected. Typed loosely (the projector takes the structural subset).
const fullResource = {
  id: 1234, // versionId
  name: 'v2.1', // versionName
  baseModel: 'Flux.1 D',
  strength: 0.8,
  settings: { strength: { min: -2, max: 3, default: 0.8 }, clipSkip: 2 },
  trainedWords: ['trigger1', 'trigger2'],
  model: {
    id: 55,
    name: 'Cool LoRA',
    type: 'LORA',
    nsfw: true,
    minor: false,
    sfwOnly: false,
    userId: 9,
  },
  // ── internals that MUST NOT leak ──
  hasAccess: true,
  availability: 'Private',
  canGenerate: true,
  earlyAccessConfig: { timeframe: 30 },
  air: 'urn:air:flux1:lora:civitai:55@1234',
  covered: true,
  image: { id: 7, url: 'abc', nsfwLevel: 4 },
  substitute: { id: 999 },
} as unknown as ProjectableGenerationResource;

describe('projectSafeGenerationResource — widened public subset, no internals', () => {
  it('carries the widened public recommended-settings + trained words', () => {
    const out = projectSafeGenerationResource(fullResource);
    expect(out).toEqual({
      versionId: 1234,
      modelId: 55,
      modelName: 'Cool LoRA',
      versionName: 'v2.1',
      baseModel: 'Flux.1 D',
      modelType: 'LORA',
      strength: 0.8,
      minStrength: -2,
      maxStrength: 3,
      trainedWords: ['trigger1', 'trigger2'],
      clipSkip: 2,
    });
  });

  it('NEVER leaks availability / hasAccess / earlyAccess / image / substitute internals', () => {
    const out = projectSafeGenerationResource(fullResource) as Record<string, unknown>;
    for (const leaked of [
      'hasAccess',
      'availability',
      'canGenerate',
      'earlyAccessConfig',
      'air',
      'covered',
      'image',
      'substitute',
      'model', // no nested model object (only flat modelId/modelName/modelType)
    ]) {
      expect(out).not.toHaveProperty(leaked);
    }
    // model.nsfw / model.minor / model.sfwOnly / model.userId are inside `model`,
    // which is not projected at all — belt-and-suspenders.
    expect(JSON.stringify(out)).not.toContain('userId');
    expect(JSON.stringify(out)).not.toContain('sfwOnly');
  });

  it('applies the getResourceData defaults when settings are absent (parity picker⇄rehydrate)', () => {
    const bare: ProjectableGenerationResource = {
      id: 2,
      name: 'v1',
      baseModel: 'SDXL 1.0',
      model: { id: 3, name: 'M', type: 'Checkpoint' },
    };
    const out = projectSafeGenerationResource(bare);
    expect(out.strength).toBe(1);
    expect(out.minStrength).toBe(-1);
    expect(out.maxStrength).toBe(2);
    expect(out.trainedWords).toEqual([]);
    expect(out.clipSkip).toBeNull();
  });

  it('treats null settings the same as absent (nullish coalescing)', () => {
    const out = projectSafeGenerationResource({
      id: 4,
      name: 'v',
      baseModel: 'SD 1.5',
      strength: null,
      settings: null,
      trainedWords: null,
      model: { id: 5, name: 'X', type: 'LORA' },
    });
    expect(out.strength).toBe(1);
    expect(out.trainedWords).toEqual([]);
    expect(out.clipSkip).toBeNull();
  });

  // The flat contract's defaults must hold per field, not only when the whole object is absent.
  it('defaults each settings field on its own when the object is there but the field is not', () => {
    const base = {
      id: 6,
      name: 'v',
      baseModel: 'SD 1.5',
      model: { id: 7, name: 'Y', type: 'LORA' },
    };
    const noStrength = projectSafeGenerationResource({ ...base, settings: { strength: null } });
    expect([noStrength.strength, noStrength.minStrength, noStrength.maxStrength]).toEqual([
      1, -1, 2,
    ]);
    const noClip = projectSafeGenerationResource({
      ...base,
      settings: { strength: { min: 0, max: 1, default: 0.5 }, clipSkip: null },
    });
    expect(noClip.clipSkip).toBeNull();
    expect(noClip.minStrength).toBe(0);
  });

  it('a working strength wins over the version default, which wins over 1', () => {
    const base = {
      id: 8,
      name: 'v',
      baseModel: 'SD 1.5',
      model: { id: 9, name: 'Z', type: 'LORA' },
    };
    const range = { min: 0, max: 1, default: 0.4 };
    expect(
      projectSafeGenerationResource({ ...base, strength: 0.9, settings: { strength: range } })
        .strength
    ).toBe(0.9);
    expect(
      projectSafeGenerationResource({ ...base, strength: null, settings: { strength: range } })
        .strength
    ).toBe(0.4);
  });
});
