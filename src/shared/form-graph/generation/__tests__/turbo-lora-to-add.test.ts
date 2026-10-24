import { describe, expect, it } from 'vitest';
import { turboLoraToAdd, turboLoraValue } from '~/shared/form-graph/generation/turbo';

const FAMILY = 3411385;
const pick = turboLoraValue(9000002);
const data = (id: number, strength: number) =>
  ({
    id,
    name: 'v',
    baseModel: 'MOSS Image',
    canGenerate: true,
    settings: { strength: { min: -1, max: 2, default: strength } },
    model: { id: 1, name: 'M', type: 'LORA' },
  } as unknown as NonNullable<Parameters<typeof turboLoraToAdd>[0]['hydrated']>);
const hydrated = data(pick.id, 0.8);
const familyDefault = data(FAMILY, 0.5);

describe('turboLoraToAdd', () => {
  it.each([
    [
      'nothing while the pick is loading',
      { hydrated: undefined, loading: true },
      { status: 'loading' },
    ],
    [
      "the hydrated pick at the pick's own strength",
      { hydrated, loading: false, pick: { ...pick, strength: 0.6 } },
      { status: 'ready', lora: { id: pick.id, strength: 0.6 } },
    ],
    [
      "the hydrated pick at the LoRA's default strength",
      { hydrated: { ...hydrated, canGenerate: undefined }, loading: false },
      { status: 'ready', lora: { id: pick.id, strength: 0.8 } },
    ],
    [
      'the family default when the pick cannot be generated with',
      { hydrated: { ...hydrated, canGenerate: false }, loading: false },
      { status: 'fallback', lora: { id: FAMILY, strength: 0.5 } },
    ],
    [
      'the family default when the pick is gone',
      { hydrated: undefined, loading: false },
      { status: 'fallback', lora: { id: FAMILY, strength: 0.5 } },
    ],
    [
      'the bare family default at 1 before it is hydrated',
      { hydrated: undefined, loading: false, familyDefault: undefined },
      { status: 'fallback', lora: { id: FAMILY, strength: 1 } },
    ],
    [
      'nothing when the unusable pick is the family default itself',
      { hydrated: undefined, loading: false, pick: turboLoraValue(FAMILY) },
      { status: 'unavailable' },
    ],
  ] as const)('adds %s', (_, args, expected) => {
    const result = turboLoraToAdd({ pick, familyDefaultId: FAMILY, familyDefault, ...args });
    expect(result).toMatchObject(expected);
    expect('lora' in result).toBe('lora' in expected);
  });
});
