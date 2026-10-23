import { describe, expect, it } from 'vitest';
import {
  LOOKUP_NOT_FOUND,
  parseResourceLookup,
  resolveLookupHit,
  type LookupContext,
} from '~/components/ImageGeneration/GenerationForm/resource-lookup';

describe('parseResourceLookup', () => {
  it.each([
    ['https://civitai.com/models/123', { modelId: 123 }, true],
    ['https://civitai.com/models/123/some-slug', { modelId: 123 }, true],
    [
      'https://civitai.red/models/123?modelVersionId=456',
      { modelId: 123, modelVersionId: 456 },
      true,
    ],
    ['civitai.com/models/123?modelVersionId=456', { modelId: 123, modelVersionId: 456 }, true],
    ['https://www.civitai.red/models/123', { modelId: 123 }, true],
    ['https://civitai.com/model-versions/789', { modelVersionId: 789 }, true],
    ['  123  ', { modelId: 123 }, false],
  ])('%s', (text, lookup, isLink) => {
    expect(parseResourceLookup(text)).toEqual({ lookup, isLink });
  });

  it('drops a junk version param but keeps the model', () => {
    expect(parseResourceLookup('https://civitai.com/models/123?modelVersionId=abc')).toEqual({
      lookup: { modelId: 123 },
      isLink: true,
    });
  });

  it.each([
    'pony',
    '',
    '0',
    '12abc',
    '99999999999999999999',
    'https://civitai.com/images/5',
    'https://evil-civitai.red/models/123',
    'https://example.com/models/123',
    'https://image.civitai.com/models/123',
  ])('%j is a name search, not a lookup', (text) => {
    expect(parseResourceLookup(text)).toBeNull();
  });
});

const version = (id: number, baseModel: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `v${id}`,
  baseModel,
  canGenerate: true,
  canGenerateNext: true,
  ...extra,
});

const ctx = (overrides: Partial<LookupContext> = {}): LookupContext => ({
  resources: [{ type: 'LORA', baseModels: ['Pony', 'Illustrious'] }],
  filters: { types: [], baseModels: [], loadedOnly: false, turboOnly: false },
  excludedIds: [],
  skipBaseModel: false,
  ...overrides,
});

const lora = (versions = [version(1, 'Pony'), version(2, 'SDXL 1.0')]) => ({
  name: 'Ink Style',
  type: 'LORA',
  versions,
});

describe('resolveLookupHit', () => {
  it('shows the compatible versions with no note', () => {
    const { versions, note } = resolveLookupHit(lora(), ctx());
    expect(versions.map((v) => v.id)).toEqual([1]);
    expect(note).toBeNull();
  });

  it('shows only the pasted version when it is compatible', () => {
    const model = lora([version(1, 'Pony'), version(3, 'Illustrious')]);
    const { versions, note } = resolveLookupHit(model, ctx({ modelVersionId: 3 }));
    expect(versions.map((v) => v.id)).toEqual([3]);
    expect(note).toBeNull();
  });

  it('names the type when the picker does not take it', () => {
    const { versions, note } = resolveLookupHit({ ...lora(), type: 'Checkpoint' }, ctx());
    expect(versions).toEqual([]);
    expect(note).toBe(
      "“Ink Style” is a Checkpoint, which can't be added here. This picker takes: LoRA."
    );
  });

  it('names the base model when no version is compatible', () => {
    const { versions, note } = resolveLookupHit(lora([version(2, 'SDXL 1.0')]), ctx());
    expect(versions).toEqual([]);
    expect(note).toBe(
      "“Ink Style” is for SDXL 1.0, which isn't compatible with your selected resources (Pony, Illustrious)."
    );
  });

  it('explains a pasted incompatible version and still offers the compatible ones', () => {
    const { versions, note } = resolveLookupHit(lora(), ctx({ modelVersionId: 2 }));
    expect(versions.map((v) => v.id)).toEqual([1]);
    expect(note).toBe(
      "v2 of “Ink Style” is for SDXL 1.0, which isn't compatible with your selected resources (Pony, Illustrious). Versions you can add are shown below."
    );
  });

  it('says when the pasted version is already added', () => {
    const { note } = resolveLookupHit(lora(), ctx({ modelVersionId: 1, excludedIds: [1] }));
    expect(note).toBe('v1 of “Ink Style” is already added.');
  });

  it("names the viewer's own base model filter", () => {
    const filters = { types: [], baseModels: ['Illustrious'], loadedOnly: false, turboOnly: false };
    const { note } = resolveLookupHit(lora([version(1, 'Pony')]), ctx({ filters } as never));
    expect(note).toBe('“Ink Style” is hidden by your base model filter.');
  });

  it("names the viewer's own type filter", () => {
    const filters = { types: ['VAE'], baseModels: [], loadedOnly: false, turboOnly: false };
    const { note } = resolveLookupHit(lora(), ctx({ filters } as never));
    expect(note).toBe('“Ink Style” is hidden by your type filter.');
  });

  it('says a non-generatable model cannot be used in the generator', () => {
    const model = lora([version(1, 'Pony', { canGenerate: false, canGenerateNext: false })]);
    const { versions, note } = resolveLookupHit(model, ctx({ canGenerate: true }));
    expect(versions).toEqual([]);
    expect(note).toBe("“Ink Style” isn't available for generation.");
  });

  it('ignores the base model where the picker does (own / official tabs)', () => {
    const { versions } = resolveLookupHit(
      lora([version(2, 'SDXL 1.0')]),
      ctx({ skipBaseModel: true })
    );
    expect(versions.map((v) => v.id)).toEqual([2]);
  });

  it('falls back to the generic not-found copy for a model with no indexed versions', () => {
    expect(resolveLookupHit(lora([]), ctx()).note).toBe(LOOKUP_NOT_FOUND);
  });
});
