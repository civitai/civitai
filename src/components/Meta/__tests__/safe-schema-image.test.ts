import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { profileSchemaImageUrl, safeSchemaImageUrl } from '~/components/Meta/safe-schema-image';
import { NsfwLevel } from '~/server/common/enums';

describe('safeSchemaImageUrl', () => {
  it.each([
    ['PG', NsfwLevel.PG],
    ['PG13', NsfwLevel.PG13],
  ])('names a %s image', (_, nsfwLevel) => {
    expect(safeSchemaImageUrl({ url: 'cover-key', nsfwLevel }, { width: 1200 })).toMatch(
      /cover-key.*width=1200|width=1200.*cover-key/
    );
  });

  it.each([
    ['R', NsfwLevel.R],
    ['XXX', NsfwLevel.XXX],
    ['PG combined with R', NsfwLevel.PG | NsfwLevel.R],
    ['unrated', 0],
  ])('names no %s image', (_, nsfwLevel) => {
    expect(safeSchemaImageUrl({ url: 'cover-key', nsfwLevel })).toBeUndefined();
  });

  it('names nothing without an image', () => {
    expect(safeSchemaImageUrl(null)).toBeUndefined();
    expect(safeSchemaImageUrl({ url: null, nsfwLevel: NsfwLevel.PG })).toBeUndefined();
  });
});

describe('profileSchemaImageUrl', () => {
  it('names a safe-rated avatar at 1200 wide', () => {
    const url = profileSchemaImageUrl({ url: 'avatar-key', nsfwLevel: NsfwLevel.PG });
    expect(url).toContain('avatar-key');
    expect(url).toContain('width=1200');
  });

  it.each([
    ['R', NsfwLevel.R],
    ['unrated', 0],
  ])('names no %s avatar', (_, nsfwLevel) => {
    expect(profileSchemaImageUrl({ url: 'avatar-key', nsfwLevel })).toBeUndefined();
  });

  it('names nothing for a local blob preview or no avatar', () => {
    expect(
      profileSchemaImageUrl({ url: 'blob:https://civitai.com/x', nsfwLevel: NsfwLevel.PG })
    ).toBeUndefined();
    expect(profileSchemaImageUrl(null)).toBeUndefined();
  });
});

// The builders are tested directly; these pin that the pages route their schema media through them
// rather than building it inline. A text check, so it catches a rewrite, not a condition.
describe('pages build schema media through the rating-checked builders', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), 'src', path), 'utf8');

  it('the image detail page', () => {
    const src = read('components/Image/DetailV2/ImageDetail2.tsx');
    expect(src).toMatch(/const mediaSchema = buildImageMediaSchema\(/);
    expect(src).toMatch(/\n\s+schema: mediaSchema,\n/);
    expect(src).not.toMatch(/'@type': '(VideoObject|ImageObject)'/);
  });

  it('the article page', () => {
    const src = read('pages/articles/[id]/[[...slug]].tsx');
    expect(src).toMatch(/\n\s+image: safeSchemaImageUrl\(article\.coverImage, /);
    expect(src).not.toMatch(/getEdgeUrl\(/);
  });
});
