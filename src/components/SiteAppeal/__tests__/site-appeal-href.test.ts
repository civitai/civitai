import { describe, expect, it } from 'vitest';
import {
  LEGACY_APPEAL_PATH,
  siteAppealHref,
  siteAppealPathFromQuery,
} from '~/components/SiteAppeal/site-appeal-href';

describe('siteAppealHref', () => {
  // `/appeal` is a 404 without the flag, so a link there would strand the user.
  it('points at the old form while the on-site one is not enabled', () => {
    expect(siteAppealHref(false)).toBe(LEGACY_APPEAL_PATH);
    expect(siteAppealHref(false, { category: 'Model', id: 5 })).toBe('/content/content-appeal');
  });

  it('points at the on-site form, preselected when the caller knows what is appealed', () => {
    expect(siteAppealHref(true)).toBe('/appeal');
    expect(siteAppealHref(true, { category: 'Model', id: 5 })).toBe('/appeal?category=Model&id=5');
    expect(siteAppealHref(true, { category: 'Other' })).toBe('/appeal?category=Other');
  });
});

describe('siteAppealPathFromQuery', () => {
  it('carries only the deep link over', () => {
    expect(siteAppealPathFromQuery({ category: 'Article', id: '9', slug: 'x', utm: 'y' })).toBe(
      '/appeal?category=Article&id=9'
    );
    expect(siteAppealPathFromQuery({})).toBe('/appeal');
    expect(siteAppealPathFromQuery({ category: ['Model', 'Other'], id: '' })).toBe('/appeal');
  });
});
