import { describe, expect, it } from 'vitest';
import { MODERATOR_WORKFLOW_FILTER_MAX, moderatorUserLookupPath } from '../moderator-paths';

const url = (path: string) => new URL(path, 'http://x');
const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `5-20260101${String(i).padStart(9, '0')}`);

describe('moderatorUserLookupPath workflows', () => {
  it('carries the ids as the comma list the page reads back', () => {
    const path = moderatorUserLookupPath(5, 'generation', { workflows: ids(2) });
    expect(url(path).pathname).toBe('/retool/user-lookup/generation');
    expect(url(path).searchParams.get('q')).toBe('5');
    expect(url(path).searchParams.get('workflows')).toBe(ids(2).join(','));
  });

  // The bare route redirects keeping only `q`, which would drop the filter.
  it('lands on the generation section when no section is given', () => {
    const path = moderatorUserLookupPath(5, undefined, { workflows: ids(1) });
    expect(url(path).pathname).toBe('/retool/user-lookup/generation');
  });

  it('bounds the URL to one past the cap, so the page can still say ids were left out', () => {
    const path = moderatorUserLookupPath(5, 'generation', {
      workflows: ids(MODERATOR_WORKFLOW_FILTER_MAX + 50),
    });
    expect(url(path).searchParams.get('workflows')!.split(',')).toHaveLength(
      MODERATOR_WORKFLOW_FILTER_MAX + 1
    );
  });

  // The page treats a present-but-empty `workflows=` as "show none", not as "show all".
  it('omits the param for an empty list rather than narrowing to nothing', () => {
    const path = moderatorUserLookupPath(5, 'generation', { workflows: [] });
    expect(url(path).searchParams.has('workflows')).toBe(false);
  });
});
