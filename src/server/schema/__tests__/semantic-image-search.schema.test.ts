import { describe, expect, it } from 'vitest';
import { semanticImageSearchSchema } from '~/server/schema/semantic-image-search.schema';
import { baseModels } from '~/shared/constants/basemodel.constants';

// The images feed's filters carry into the search unchanged: whatever the feed can select must parse.
describe('semanticImageSearchSchema', () => {
  const parse = (over: Record<string, unknown>) =>
    semanticImageSearchSchema.safeParse({ query: 'a red fox', ...over }).success;

  it('accepts every base model the feed offers', () => {
    expect(parse({ baseModels: [...baseModels] })).toBe(true);
  });

  it('accepts up to 100 tags, and no more', () => {
    const tags = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    expect(parse({ tagIds: tags(100) })).toBe(true);
    expect(parse({ tagIds: tags(101) })).toBe(false);
  });
});
