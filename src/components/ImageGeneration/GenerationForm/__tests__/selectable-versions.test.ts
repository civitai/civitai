import { describe, expect, it } from 'vitest';
import { selectableVersions } from '~/components/ImageGeneration/GenerationForm/resource-select.types';

const version = (
  id: number,
  overrides: Partial<Parameters<typeof selectableVersions>[0][number]> = {}
) => ({
  id,
  baseModel: 'SDXL 1.0',
  canGenerate: true,
  canGenerateNext: true,
  generatorLoaded: false,
  ...overrides,
});

const pick = (
  versions: ReturnType<typeof version>[],
  opts: Partial<Parameters<typeof selectableVersions>[1]> = {}
) =>
  selectableVersions(versions, {
    skipBaseModel: true,
    modelBaseModels: [],
    excludedIds: [],
    ...opts,
  }).map((v) => v.id);

describe('selectableVersions', () => {
  it('keeps every version when nothing narrows them', () => {
    expect(pick([version(1), version(2)])).toEqual([1, 2]);
  });

  // The index filter matches a MODEL whose nested array holds a resident version, so without this
  // the card can land on a cold one inside a list the user asked to be loaded only.
  it('keeps only resident versions under the loaded filter', () => {
    expect(
      pick([version(1), version(2, { generatorLoaded: true }), version(3)], { loadedOnly: true })
    ).toEqual([2]);
  });

  // Versions arrive in the model's own order, so the first survivor is what the card selects.
  it('leaves the topmost loaded version first, which is the one the card selects', () => {
    const [first] = pick(
      [version(9), version(8, { generatorLoaded: true }), version(7, { generatorLoaded: true })],
      { loadedOnly: true }
    );
    expect(first).toBe(8);
  });

  // Crossed on purpose: a card reading the field the server did not filter on keeps the wrong version.
  const crossed = [
    version(1, { canGenerate: false, canGenerateNext: true }),
    version(2, { canGenerate: true, canGenerateNext: false }),
  ];

  it('gates on the staged rule when that is the live one', () => {
    expect(pick(crossed, { canGenerate: true, coverageNext: true })).toEqual([1]);
  });

  it('gates on the live rule when the flag is off', () => {
    expect(pick(crossed, { canGenerate: true, coverageNext: false })).toEqual([2]);
  });

  it('drops excluded ids and off-ecosystem base models', () => {
    expect(pick([version(1), version(2)], { excludedIds: [2] })).toEqual([1]);
    expect(
      pick([version(1), version(2, { baseModel: 'Pony' })], {
        skipBaseModel: false,
        modelBaseModels: ['Pony'],
      })
    ).toEqual([2]);
  });
});
