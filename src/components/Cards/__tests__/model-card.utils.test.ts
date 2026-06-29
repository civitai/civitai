import { describe, expect, it } from 'vitest';
import { getCardBaseModels } from '~/components/Cards/model-card.utils';

describe('getCardBaseModels', () => {
  it('prefers feed baseModels array, deduped in order', () => {
    expect(getCardBaseModels({ baseModels: ['Pony', 'SD 1.5', 'Pony'] as any })).toEqual([
      'Pony',
      'SD 1.5',
    ]);
  });

  it('falls back to versions[] when baseModels absent', () => {
    expect(
      getCardBaseModels({ versions: [{ baseModel: 'Pony' }, { baseModel: 'Illustrious' }] as any })
    ).toEqual(['Pony', 'Illustrious']);
  });

  it('falls back to singular version when others absent', () => {
    expect(getCardBaseModels({ version: { baseModel: 'SD 1.5' } as any })).toEqual(['SD 1.5']);
  });

  it('floats matched base models to the front, stable otherwise', () => {
    expect(
      getCardBaseModels({ baseModels: ['Pony', 'SD 1.5', 'Illustrious'] as any }, ['SD 1.5'])
    ).toEqual(['SD 1.5', 'Pony', 'Illustrious']);
  });

  it('is a no-op for a single base model', () => {
    expect(getCardBaseModels({ baseModels: ['Pony'] as any }, ['SD 1.5'])).toEqual(['Pony']);
  });

  it('returns empty array when no base model anywhere', () => {
    expect(getCardBaseModels({})).toEqual([]);
  });
});
