import { describe, expect, it } from 'vitest';
import { keepStoredProfanityData } from '~/libs/profanity-simple/helpers';

type Details = Parameters<typeof keepStoredProfanityData>[0];
const details = (value: Record<string, unknown>) => value as Details;

describe('keepStoredProfanityData', () => {
  const stored = { baseModel: 'SD 1.5', profanityMatches: ['term'], profanityEvaluation: { r: 1 } };

  it('returns the incoming details when nothing usable is stored', () => {
    expect(keepStoredProfanityData(details({ baseModel: 'SDXL 1.0' }), null)).toEqual({
      baseModel: 'SDXL 1.0',
    });
    expect(keepStoredProfanityData(details({ baseModel: 'SDXL 1.0' }), ['term'])).toEqual({
      baseModel: 'SDXL 1.0',
    });
  });

  it('keeps the stored fields when the write sends no details', () => {
    expect(keepStoredProfanityData(null, stored)).toEqual({
      profanityMatches: ['term'],
      profanityEvaluation: { r: 1 },
    });
  });

  it('lets a write that carries its own fields replace the stored ones', () => {
    const incoming = details({ baseModel: 'SDXL 1.0', profanityMatches: ['new'] });
    expect(keepStoredProfanityData(incoming, stored)).toEqual(incoming);
  });

  it('keeps only the field that is stored', () => {
    expect(
      keepStoredProfanityData(details({ baseModel: 'SDXL 1.0' }), { profanityMatches: ['term'] })
    ).toEqual({ baseModel: 'SDXL 1.0', profanityMatches: ['term'] });
  });
});
