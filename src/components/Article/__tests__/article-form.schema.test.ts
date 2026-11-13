import { describe, expect, it } from 'vitest';
import { articleFormSchema } from '~/components/Article/article-form.schema';

const image = { url: '00000000-0000-4000-8000-000000000000' };
const base = { title: 'An article', content: '<p>Hi</p>', categoryId: 1, tags: [] };

const errorPaths = (withBanner: boolean, images: Record<string, unknown>) => {
  const result = articleFormSchema(withBanner).safeParse({ ...base, ...images });
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
};

describe('article form: cover or banner', () => {
  it('takes a banner-only article when the banner field is shown', () => {
    expect(errorPaths(true, { coverImage: null, bannerImage: image })).toEqual([]);
  });

  it('takes a cover-only article', () => {
    expect(errorPaths(true, { coverImage: image, bannerImage: null })).toEqual([]);
  });

  it('asks for a cover when there is neither', () => {
    expect(errorPaths(true, { coverImage: null, bannerImage: null })).toContain('coverImage');
  });

  it('still asks for a cover when the banner field is hidden, even with a saved banner', () => {
    expect(errorPaths(false, { coverImage: null, bannerImage: image })).toContain('coverImage');
  });
});
