import { describe, expect, it } from 'vitest';

import type { TagPageSeoData } from '~/server/services/tag.service';
import {
  shouldDeIndexAdultTermOnGreen,
  shouldDeIndexMatureOnlyTag,
  shouldDeIndexSafeOnlyTag,
  shouldPointTagCanonicalAtGreen,
} from '~/server/services/tag.service';

const green = (data: Partial<TagPageSeoData>): TagPageSeoData => ({
  count: 0,
  hasModels: false,
  models: [],
  ...data,
});
const red = (data: Partial<TagPageSeoData>): TagPageSeoData => ({
  count: 0,
  matureCount: 0,
  models: [],
  ...data,
});

describe('shouldDeIndexMatureOnlyTag', () => {
  it('deindexes on green when every model is one green cannot show', () => {
    expect(shouldDeIndexMatureOnlyTag(green({ count: 0, hasModels: true }))).toBe(true);
  });

  it('indexes a tag green can show something for', () => {
    expect(shouldDeIndexMatureOnlyTag(green({ count: 12, hasModels: true }))).toBe(false);
  });

  it('leaves a tag with no models at all to the empty-tag rules', () => {
    expect(shouldDeIndexMatureOnlyTag(green({ count: 0, hasModels: false }))).toBe(false);
  });

  it('never fires on a red read', () => {
    expect(shouldDeIndexMatureOnlyTag(red({ count: 0, matureCount: 0 }))).toBe(false);
  });
});

describe('shouldDeIndexSafeOnlyTag', () => {
  it('deindexes on red when nothing in the tag is green-only content', () => {
    expect(shouldDeIndexSafeOnlyTag(red({ count: 40, matureCount: 0 }))).toBe(true);
  });

  it('indexes a tag with any mature model', () => {
    expect(shouldDeIndexSafeOnlyTag(red({ count: 40, matureCount: 1 }))).toBe(false);
  });

  it('leaves an empty tag alone', () => {
    expect(shouldDeIndexSafeOnlyTag(red({ count: 0, matureCount: 0 }))).toBe(false);
  });

  it('never fires on a green read, nor on data with no matureCount at all', () => {
    expect(shouldDeIndexSafeOnlyTag(green({ count: 40, hasModels: true }))).toBe(false);
    expect(shouldDeIndexSafeOnlyTag({ count: 40, models: [] })).toBe(false);
  });
});

describe('shouldPointTagCanonicalAtGreen', () => {
  it('gives green the canonical when it holds more than half the listing', () => {
    expect(shouldPointTagCanonicalAtGreen(red({ count: 100, matureCount: 49 }))).toBe(true);
  });

  it('keeps red canonical when the content is mostly mature', () => {
    expect(shouldPointTagCanonicalAtGreen(red({ count: 100, matureCount: 51 }))).toBe(false);
  });

  it('keeps red canonical on an exact half, so a tie never moves the page', () => {
    expect(shouldPointTagCanonicalAtGreen(red({ count: 100, matureCount: 50 }))).toBe(false);
  });

  it('does nothing for an empty tag, a green read, or data with no matureCount', () => {
    expect(shouldPointTagCanonicalAtGreen(red({ count: 0, matureCount: 0 }))).toBe(false);
    expect(shouldPointTagCanonicalAtGreen(green({ count: 100, hasModels: true }))).toBe(false);
    expect(shouldPointTagCanonicalAtGreen({ count: 100, models: [] })).toBe(false);
  });
});

describe('shouldDeIndexAdultTermOnGreen', () => {
  it('deindexes an adult term on green even when its models are all safe', () => {
    expect(
      shouldDeIndexAdultTermOnGreen(green({ count: 40, hasModels: true, nsfwTerm: true }))
    ).toBe(true);
  });

  it('leaves an ordinary term alone', () => {
    expect(shouldDeIndexAdultTermOnGreen(green({ count: 40, nsfwTerm: false }))).toBe(false);
  });

  it('does nothing on data with no flag at all, rather than guessing', () => {
    expect(shouldDeIndexAdultTermOnGreen({ count: 40, models: [] })).toBe(false);
  });
});

describe('shouldPointTagCanonicalAtGreen, for an adult term', () => {
  it('never hands green the canonical, however safe the models are', () => {
    expect(
      shouldPointTagCanonicalAtGreen(red({ count: 100, matureCount: 1, nsfwTerm: true }))
    ).toBe(false);
  });
});
