import { describe, expect, it } from 'vitest';
import { isKnightsTagGroupKey, KNIGHTS_TAG_GROUPS, tagIdsOfGroups } from '../knights-tag-groups';

// Knights exists so the community rates mature content: a group must never let a player hide it. These are the tag
// names the moderators' rating tags use for sexual content and nudity.
const SEXUAL_TAG_WORDS = [
  'nud',
  'sex',
  'explicit',
  'porn',
  'hentai',
  'nsfw',
  'erotic',
  'genital',
  'breast',
  'nipple',
  'lingerie',
  'underwear',
  'swimwear',
  'suggestive',
  'adult',
];

describe('the preset tag groups', () => {
  it('never hide sexual content or nudity', () => {
    for (const group of KNIGHTS_TAG_GROUPS)
      for (const tag of group.tags)
        for (const word of SEXUAL_TAG_WORDS) expect(tag.name.toLowerCase()).not.toContain(word);
  });

  it('are the main-site topics a player can already hide: anime, furry, gore and political', () => {
    expect(KNIGHTS_TAG_GROUPS.map((g) => g.key)).toEqual(['anime', 'furry', 'gore', 'political']);
    expect(tagIdsOfGroups(['anime', 'political'])).toEqual([4, 413, 2470]);
  });

  it('have unique keys and no tag in two groups', () => {
    const keys = KNIGHTS_TAG_GROUPS.map((g) => g.key);
    const tags = KNIGHTS_TAG_GROUPS.flatMap((g) => g.tags.map((t) => t.id));
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('know their own keys and nothing else', () => {
    expect(isKnightsTagGroupKey('gore')).toBe(true);
    expect(isKnightsTagGroupKey('sexual')).toBe(false);
    expect(tagIdsOfGroups(['nope'])).toEqual([]);
  });
});
