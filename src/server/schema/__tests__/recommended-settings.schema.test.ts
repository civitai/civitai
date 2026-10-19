import { describe, expect, it } from 'vitest';
import { recommendedSettingsSchema } from '~/server/schema/model-version.schema';

const range = (min: number, max: number, def: number) => ({ min, max, default: def });

describe('recommendedSettingsSchema', () => {
  it('keeps the strength trio parsing as before', () => {
    expect(recommendedSettingsSchema.parse({ minStrength: '0.5', maxStrength: 1 })).toEqual({
      minStrength: 0.5,
      maxStrength: 1,
    });
  });

  it('accepts a turbo block whose defaults sit inside their bands', () => {
    const parsed = recommendedSettingsSchema.parse({
      turbo: { steps: range(4, 12, 8), cfgScale: range('1', '1.5', '1') },
    });
    expect(parsed.turbo).toEqual({ steps: range(4, 12, 8), cfgScale: range(1, 1.5, 1) });
  });

  it('refuses a turbo block missing a band, since presence is what makes a LoRA turbo', () => {
    expect(recommendedSettingsSchema.safeParse({ turbo: { steps: range(4, 12, 8) } }).success).toBe(
      false
    );
  });

  it('refuses an inverted band and names the field', () => {
    const result = recommendedSettingsSchema.safeParse({
      generation: { steps: range(40, 20, 25) },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain('generation.steps.min');
  });

  it('refuses a default outside its band and names the field', () => {
    const result = recommendedSettingsSchema.safeParse({
      generation: { cfgScale: range(2, 5, 7) },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain(
      'generation.cfgScale.default'
    );
  });

  // The editor renders both bands for every checkpoint; cleared inputs submit '' and must not block the save.
  it('treats a band of blank inputs as no recommendation', () => {
    const blank = { min: '', max: '', default: '' };
    const parsed = recommendedSettingsSchema.parse({
      generation: { steps: blank, cfgScale: blank },
    });
    expect(parsed.generation).toBeUndefined();
  });

  it('keeps the turbo LoRA a checkpoint names', () => {
    const parsed = recommendedSettingsSchema.parse({
      generation: { steps: { min: '', max: '', default: '' }, turboLora: { id: 3413516 } },
    });
    expect(parsed.generation).toEqual({ turboLora: { id: 3413516 } });
  });

  it('lets a checkpoint recommend one of the two', () => {
    expect(
      recommendedSettingsSchema.safeParse({ generation: { steps: range(20, 40, 25) } }).success
    ).toBe(true);
  });
});
