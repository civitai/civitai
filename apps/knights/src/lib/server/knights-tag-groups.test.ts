import { describe, expect, it } from 'vitest';
import { isKnightsTagGroupKey, KNIGHTS_TAG_GROUPS, tagIdsOfGroups } from './knights-tag-groups';

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

  it('are the groups agreed with Moderation, in settings order', () => {
    expect(KNIGHTS_TAG_GROUPS.map((g) => g.key)).toEqual([
      'furry',
      'male-focus',
      'feet',
      'bondage',
      'futanari',
      'gore',
    ]);
    expect(tagIdsOfGroups(['feet', 'futanari'])).toEqual([5311, 137120, 279, 3616]);
  });

  it('describe what they hide in other words than their name', () => {
    for (const group of KNIGHTS_TAG_GROUPS)
      expect(group.description.toLowerCase()).not.toBe(group.label.toLowerCase());
  });

  it('never hide by an orientation tag alone', () => {
    const names = KNIGHTS_TAG_GROUPS.flatMap((g) => g.tags.map((t) => t.name));
    for (const orientation of ['gay', 'lesbian', 'bisexual', 'transgender'])
      expect(names).not.toContain(orientation);
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
