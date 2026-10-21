import { describe, expect, it } from 'vitest';
import { setCrucibleEventTagsSchema } from '~/server/schema/crucible.schema';

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

  it.each(['', 'spooky season', 'trick!', '-leading-dash', 'x'.repeat(33)])('rejects %j', (tag) => {
    expect(setCrucibleEventTagsSchema.safeParse({ id: 1, eventTags: [tag] }).success).toBe(false);
  });

  it('accepts an empty list, which clears the tags', () => {
    expect(setCrucibleEventTagsSchema.parse({ id: 1, eventTags: [] }).eventTags).toEqual([]);
  });
});
