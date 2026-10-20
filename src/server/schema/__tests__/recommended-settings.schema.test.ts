import { describe, expect, it } from 'vitest';
import { recommendedSettingsSchema } from '~/server/schema/model-version.schema';

const range = (min: number | string, max: number | string, def: number | string) => ({
  min,
  max,
  default: def,
});
const cfg = range(1, 1.5, 1);

describe('recommendedSettingsSchema', () => {
  it('keeps the strength trio parsing as before', () => {
    expect(recommendedSettingsSchema.parse({ minStrength: '0.5', maxStrength: 1 })).toEqual({
      minStrength: 0.5,
      maxStrength: 1,
    });
  });

  it('accepts a turbo block whose defaults sit inside their bands, coercing the form strings', () => {
    const parsed = recommendedSettingsSchema.parse({
      turbo: { steps: range('4', '12', '8'), cfgScale: cfg },
    });
    expect(parsed.turbo).toEqual({ steps: range(4, 12, 8), cfgScale: cfg });
  });

  it('refuses a turbo block missing a band, since presence is what makes a LoRA turbo', () => {
    expect(recommendedSettingsSchema.safeParse({ turbo: { steps: range(4, 12, 8) } }).success).toBe(
      false
    );
  });

  // A cleared number input submits '', which plain coercion would read as 0 and accept.
  it('refuses a cleared field rather than reading it as zero', () => {
    const result = recommendedSettingsSchema.safeParse({
      turbo: { steps: range('', 12, 8), cfgScale: cfg },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain('turbo.steps.min');
  });

  it('refuses an inverted band and names the field', () => {
    const result = recommendedSettingsSchema.safeParse({
      turbo: { steps: range(40, 20, 25), cfgScale: cfg },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain('turbo.steps.min');
  });

  it('refuses a default outside its band and names the field', () => {
    const result = recommendedSettingsSchema.safeParse({
      turbo: { steps: range(4, 12, 8), cfgScale: range(2, 5, 7) },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain('turbo.cfgScale.default');
  });

  it('keeps the turbo LoRA a checkpoint names', () => {
    const parsed = recommendedSettingsSchema.parse({ generation: { turboLora: { id: 3413516 } } });
    expect(parsed.generation).toEqual({ turboLora: { id: 3413516 } });
  });
});
