import { childBrowsingTagIds } from '@civitai/shared';
import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import {
  isTaggedMatureImage,
  isWithheldMatureCover,
} from '~/server/search-index/utils/tagged-mature-image';

const CHILD_TAG = childBrowsingTagIds[0];

describe('isWithheldMatureCover', () => {
  it('hides an R cover whose tags were not read', () => {
    expect(isWithheldMatureCover({ nsfwLevel: NsfwLevel.R, tags: undefined })).toBe(true);
  });

  it('keeps a PG-13 cover whose tags were not read', () => {
    expect(isWithheldMatureCover({ nsfwLevel: NsfwLevel.PG13, tags: undefined })).toBe(false);
  });

  it.each([
    ['an R cover with a child tag', NsfwLevel.R, [CHILD_TAG], true],
    ['an R cover with no tags', NsfwLevel.R, [], false],
    ['a PG-13 cover with a child tag', NsfwLevel.PG13, [CHILD_TAG], false],
  ])('judges %s as isTaggedMatureImage does', (_, nsfwLevel, tags, withheld) => {
    expect(isWithheldMatureCover({ nsfwLevel, tags })).toBe(withheld);
  });

  it('leaves isTaggedMatureImage failing open on unread tags for its other callers', () => {
    expect(isTaggedMatureImage({ nsfwLevel: NsfwLevel.R, tags: undefined })).toBe(false);
  });
});
