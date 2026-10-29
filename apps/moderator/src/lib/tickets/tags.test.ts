import { describe, expect, it } from 'vitest';
import { splitTags } from './tags';

describe('splitTags', () => {
  it('lifts the membership tier out of the tags', () => {
    expect(splitTags(['Bronze Membership', 'Buzz'])).toEqual({
      tier: 'Bronze Membership',
      rest: ['Buzz'],
    });
    expect(splitTags(['sent-to-support', 'Free User'])).toEqual({
      tier: 'Free User',
      rest: ['sent-to-support'],
    });
  });

  it('matches the tier case-insensitively and across every tier Freshdesk knows', () => {
    for (const t of [
      'gold membership',
      'Silver Membership',
      'Supporter Membership',
      'Buzz Purchaser',
    ]) {
      expect(splitTags([t]).tier).toBe(t);
    }
  });

  it('leaves a tag that merely contains a tier word alone', () => {
    expect(splitTags(['Gold farming', 'Free speech'])).toEqual({
      tier: null,
      rest: ['Gold farming', 'Free speech'],
    });
  });

  it('takes the first tier tag and keeps any further one as a plain tag', () => {
    expect(splitTags(['Gold Membership', 'Free User'])).toEqual({
      tier: 'Gold Membership',
      rest: ['Free User'],
    });
  });

  it('has no tier for an empty list', () => {
    expect(splitTags([])).toEqual({ tier: null, rest: [] });
  });
});
