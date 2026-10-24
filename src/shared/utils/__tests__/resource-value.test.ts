import { describe, expect, it } from 'vitest';
import type { GenerationResource } from '~/shared/types/generation.types';
import { asResourceValue, defaultStrength } from '~/shared/utils/resource.utils';

const data = (strengthDefault: number) =>
  ({
    id: 1,
    settings: { strength: { min: 0, max: 2, default: strengthDefault } },
    model: { id: 2, name: 'M', type: 'LORA' },
  } as unknown as GenerationResource);

describe('asResourceValue', () => {
  // A chosen 0 is a real weight (the bounds allow negatives), so it must not read as "none".
  it.each([
    ['the chosen weight, including 0', 0, 0],
    ['the chosen weight', 0.4, 0.4],
    ['the default when none is chosen', undefined, 0.7],
    ['the default when the choice is null', null, 0.7],
  ])('takes %s', (_, chosen, expected) => {
    expect(asResourceValue(data(0.7), chosen).strength).toBe(expected);
  });

  it('a value passed through keeps its weight', () => {
    const value = asResourceValue(data(0.7), 0.4);
    expect(asResourceValue(value).strength).toBe(0.4);
  });

  // A substitute is another version of the same model; the original's default is not its own.
  it('weights a substitute against its own default, or with the chosen weight', () => {
    const withSubstitute = {
      ...data(0.7),
      substitute: { ...data(0.5), canGenerate: true },
    } as unknown as GenerationResource;
    expect(asResourceValue(withSubstitute).substitute?.strength).toBe(0.5);
    expect(asResourceValue(withSubstitute, 0.4).substitute?.strength).toBe(0.4);
  });

  it('returns a new object and leaves the data without a weight', () => {
    const resource = data(0.7);
    const value = asResourceValue(resource, 0.4);
    expect(value).not.toBe(resource);
    expect(resource).not.toHaveProperty('strength');
  });
  it('a value saved before the settings shape starts at 1', () => {
    expect(defaultStrength({})).toBe(1);
  });
});
