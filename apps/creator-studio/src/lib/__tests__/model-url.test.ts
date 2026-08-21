import { describe, expect, it } from 'vitest';
import { Flags, NsfwLevel } from '@civitai/shared';
import { civitaiUrl, isMatureModel, modelUrl } from '../model-url';

const level = (...levels: number[]) => Flags.arrayToInstance(levels);

describe('isMatureModel', () => {
  it('is mature when the legacy nsfw flag is set, whatever the level says', () => {
    expect(isMatureModel({ nsfw: true, nsfwLevel: level(NsfwLevel.PG) })).toBe(true);
    expect(isMatureModel({ nsfw: true })).toBe(true);
  });

  it('is mature for R+ ratings with no all-ages bit', () => {
    expect(isMatureModel({ nsfwLevel: level(NsfwLevel.R) })).toBe(true);
    expect(isMatureModel({ nsfwLevel: level(NsfwLevel.X) })).toBe(true);
    expect(isMatureModel({ nsfwLevel: level(NsfwLevel.XXX) })).toBe(true);
    expect(isMatureModel({ nsfwLevel: level(NsfwLevel.R, NsfwLevel.XXX) })).toBe(true);
  });

  it('is not mature for a mixed rating — civitai.com serves the page with the R content hidden', () => {
    expect(isMatureModel({ nsfwLevel: level(NsfwLevel.PG13, NsfwLevel.R) })).toBe(false);
    expect(isMatureModel({ nsfwLevel: level(NsfwLevel.PG, NsfwLevel.XXX) })).toBe(false);
  });

  it('is not mature for all-ages ratings, an unrated model, or a Blocked-only one', () => {
    expect(isMatureModel({ nsfwLevel: level(NsfwLevel.PG) })).toBe(false);
    expect(isMatureModel({ nsfwLevel: level(NsfwLevel.PG13) })).toBe(false);
    expect(isMatureModel({ nsfwLevel: 0 })).toBe(false);
    expect(isMatureModel({})).toBe(false);
    expect(isMatureModel({ nsfwLevel: level(NsfwLevel.Blocked) })).toBe(false);
  });
});

describe('modelUrl', () => {
  it('sends a mature model to civitai.red and everything else to civitai.com', () => {
    expect(modelUrl(123, { nsfwLevel: level(NsfwLevel.X) })).toBe('https://civitai.red/models/123');
    expect(modelUrl(123, { nsfw: true })).toBe('https://civitai.red/models/123');
    expect(modelUrl(123, { nsfwLevel: level(NsfwLevel.PG13) })).toBe(
      'https://civitai.com/models/123'
    );
  });
});

describe('civitaiUrl', () => {
  it('takes a path with or without a leading slash', () => {
    expect(civitaiUrl('/images/9', { nsfwLevel: level(NsfwLevel.PG) })).toBe(
      'https://civitai.com/images/9'
    );
    expect(civitaiUrl('images/9', { nsfwLevel: level(NsfwLevel.R) })).toBe(
      'https://civitai.red/images/9'
    );
  });
});
