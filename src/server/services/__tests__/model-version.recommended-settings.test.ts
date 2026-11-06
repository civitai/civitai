import { describe, expect, it } from 'vitest';
import '~/__tests__/mocks/db.mock';
import { recommendedGenerationSettingsSchema } from '~/server/schema/model-version.schema';

const { assertRecommendedSettingsForType, withPairedStrength } = await import(
  '~/server/services/model-version.service'
);

const range = { min: 4, max: 12, default: 8 };
const turbo = { steps: range, cfgScale: { min: 1, max: 1.5, default: 1 } };

describe('assertRecommendedSettingsForType', () => {
  it('takes a turbo block on a LoRA of an ecosystem with turbo defaults', () => {
    expect(() =>
      assertRecommendedSettingsForType({ turbo }, { modelType: 'LORA', baseModel: 'MOSS Image' })
    ).not.toThrow();
  });

  it.each(['LoCon', 'DoRA'] as const)('takes a turbo block on a %s too', (modelType) => {
    expect(() =>
      assertRecommendedSettingsForType({ turbo }, { modelType, baseModel: 'MOSS Image' })
    ).not.toThrow();
  });

  it('refuses a checkpoint block on a LoRA, even in an opted-in ecosystem', () => {
    expect(() =>
      assertRecommendedSettingsForType(
        { generation: { turboLora: { id: 1 } } },
        { modelType: 'LORA', baseModel: 'MOSS Image' }
      )
    ).toThrow(/checkpoint/);
  });

  it('refuses a turbo block on a checkpoint', () => {
    expect(() =>
      assertRecommendedSettingsForType(
        { turbo },
        { modelType: 'Checkpoint', baseModel: 'MOSS Image' }
      )
    ).toThrow(/LoRA/);
  });

  // The editor never offers the section outside an opted-in ecosystem; the API must not either.
  it('refuses a turbo block where the ecosystem has no turbo defaults', () => {
    expect(() =>
      assertRecommendedSettingsForType({ turbo }, { modelType: 'LORA', baseModel: 'HiDream' })
    ).toThrow(/not supported/);
  });

  it('refuses a default turbo LoRA on a checkpoint outside such an ecosystem', () => {
    expect(() =>
      assertRecommendedSettingsForType(
        { generation: { turboLora: { id: 1 } } },
        { modelType: 'Checkpoint', baseModel: 'HiDream' }
      )
    ).toThrow(/not supported/);
  });

  it('takes a default turbo LoRA on a checkpoint of an opted-in ecosystem', () => {
    expect(() =>
      assertRecommendedSettingsForType(
        { generation: { turboLora: { id: 1 } } },
        { modelType: 'Checkpoint', baseModel: 'MOSS Image' }
      )
    ).not.toThrow();
  });
});

describe('recommendedGenerationSettingsSchema', () => {
  it.each([
    ['keeps a strength on the default turbo LoRA', { id: 1, strength: 0.6 }, true],
    ['refuses a strength past the generator range', { id: 1, strength: 2.5 }, false],
  ])('%s', (_, turboLora, ok) => {
    const result = recommendedGenerationSettingsSchema.safeParse({ turboLora });
    expect(result.success).toBe(ok);
    if (result.success) expect(result.data.turboLora).toEqual(turboLora);
    else expect(result.error.issues[0]?.path).toEqual(['turboLora', 'strength']);
  });
});

describe('withPairedStrength', () => {
  const resource = {
    id: 1,
    settings: { strength: { min: 0, max: 1, default: 0.7 } },
    turbo: true,
  } as unknown as Parameters<typeof withPairedStrength>[0];

  it("takes the row's strength and nothing else from its settings JSON", () => {
    const paired = withPairedStrength(resource, {
      strength: 0.6,
      minStrength: 5,
      turbo: { steps: { min: 1, max: 2, default: 1 } },
    });
    expect(paired).toEqual({ ...resource, strength: 0.6 });
  });

  it.each([null, undefined, {}, { strength: null }])(
    "falls back to the version's default for %s",
    (row) => {
      expect(withPairedStrength(resource, row)).toEqual({ ...resource, strength: 0.7 });
    }
  );
});
