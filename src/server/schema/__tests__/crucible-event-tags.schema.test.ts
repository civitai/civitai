import { describe, expect, it } from 'vitest';
import { setCrucibleEventTagsSchema } from '~/server/schema/crucible.schema';
import {
  CRUCIBLE_EVENT_TAG_MAX_LENGTH,
  CRUCIBLE_MAX_EVENT_TAGS,
} from '~/shared/constants/crucible.constants';

// The Feed block matches tags exactly, after lowercasing its own; a tag stored in any other
// spelling would silently never match.
describe('setCrucibleEventTagsSchema', () => {
  it('stores tags trimmed, lowercased and deduplicated', () => {
    expect(
      setCrucibleEventTagsSchema.parse({
        id: 1,
        eventTags: [' Halloween', 'halloween', 'spooky-2026'],
      }).eventTags
    ).toEqual(['halloween', 'spooky-2026']);
  });

  it.each([
    '',
    'spooky season',
    'trick!',
    '-leading-dash',
    'x'.repeat(CRUCIBLE_EVENT_TAG_MAX_LENGTH + 1),
  ])('rejects %j', (tag) => {
    expect(setCrucibleEventTagsSchema.safeParse({ id: 1, eventTags: [tag] }).success).toBe(false);
  });

  it('accepts a tag at the length limit', () => {
    const tag = 'x'.repeat(CRUCIBLE_EVENT_TAG_MAX_LENGTH);
    expect(setCrucibleEventTagsSchema.parse({ id: 1, eventTags: [tag] }).eventTags).toEqual([tag]);
  });

  it('caps how many tags a crucible carries', () => {
    const tags = (n: number) => Array.from({ length: n }, (_, i) => `tag-${i}`);
    expect(
      setCrucibleEventTagsSchema.safeParse({ id: 1, eventTags: tags(CRUCIBLE_MAX_EVENT_TAGS) })
        .success
    ).toBe(true);
    expect(
      setCrucibleEventTagsSchema.safeParse({ id: 1, eventTags: tags(CRUCIBLE_MAX_EVENT_TAGS + 1) })
        .success
    ).toBe(false);
  });

  it('accepts an empty list, which clears the tags', () => {
    expect(setCrucibleEventTagsSchema.parse({ id: 1, eventTags: [] }).eventTags).toEqual([]);
  });
});
