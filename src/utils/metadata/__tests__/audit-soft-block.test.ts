import { describe, expect, it } from 'vitest';
import {
  auditPromptEnriched,
  isSoftBlock,
  type PromptTrigger,
  type PromptTriggerCategory,
} from '~/utils/metadata/audit';
import blockedNSFW from '~/utils/metadata/lists/blocklist-nsfw.json';
import blockedNSFWOverridable from '~/utils/metadata/lists/blocklist-nsfw-overridable.json';

/**
 * The generation gate lets a user proceed past the over-eager regex categories
 * ("I know what I'm doing") but must keep hard-blocking genuinely disallowed
 * content. These lock that boundary.
 */

const trigger = (category: PromptTriggerCategory, message = 'x'): PromptTrigger => ({
  category,
  message,
  matchedWord: message,
});

describe('isSoftBlock — the overridable boundary', () => {
  it('profanity is soft', () => {
    expect(isSoftBlock([trigger('profanity', 'damn')])).toBe(true);
  });

  it.each<PromptTriggerCategory>([
    'minor_age',
    'poi',
    'inappropriate_minor',
    'inappropriate_poi',
    'harmful_combo',
    'external',
  ])('%s is hard', (category) => {
    expect(isSoftBlock([trigger(category)])).toBe(false);
  });

  it('one hard trigger poisons an otherwise soft set', () => {
    expect(isSoftBlock([trigger('nsfw_blocklist', 'daughter'), trigger('poi')])).toBe(false);
  });

  // `extModeration.moderatePrompt` relabels provider categories through the
  // EXTERNAL_MODERATION_CATEGORIES env var, so the trigger message is whatever a
  // deployment configured. No message may make an external flag overridable.
  it.each(['sexual/minors', 'CSAM', 'underage', 'harassment', 'self-harm/instructions'])(
    'external stays hard whatever label it arrives under: %s',
    (label) => {
      expect(isSoftBlock([trigger('external', label)])).toBe(false);
    }
  );

  it('an empty trigger set is hard — the over-length block reports no triggers', () => {
    expect(isSoftBlock([])).toBe(false);
    const overLength = auditPromptEnriched('a'.repeat(20001));
    expect(overLength.success).toBe(false);
    expect(isSoftBlock(overLength.triggers)).toBe(false);
  });
});

describe('nsfw_blocklist severity is per word, not per category', () => {
  // Literal, and deliberately NOT derived from the file's complement: this list is
  // a frozen "must never become overridable" contract, and deriving it would make
  // it silently follow whatever the overridable file says.
  it.each([
    'rape',
    'raping',
    'statutory rape',
    'lolita',
    'loli',
    'lolicon',
    'shota',
    'cunny',
    'jailbait',
    'jail bait',
    'incest',
    'bestiality',
    'beastiality',
    'necrophilia',
    'non-consensual',
    'nonconsensual',
    'pedophile',
    'paedophile',
    'pedobear',
    'ddlg',
    'nigger',
    'nigga',
    'n1gger',
    'chink',
    'kike',
    'spic',
    'gook',
    'wetback',
    'paki',
    'raghead',
    'towelhead',
    'jigaboo',
    'porch monkey',
    'darkie',
    'beaner',
    'wop',
    'rice nigger',
    'dune coon',
    'coonass',
    'niglet',
    'nignog',
    'wigger',
    'africoon',
    'retard',
    'mongoloid',
    'coon',
    'coons',
    'kraut',
    'necro',
    'puberty',
    'gas chamber',
    'kkk',
    'pro-ana',
    'pro-mia',
  ])('hard tier: %s is NOT overridable', (word) => {
    expect(isSoftBlock([trigger('nsfw_blocklist', word)])).toBe(false);
  });

  // Derived, not re-listed: a word ADDED to the file is the dangerous direction,
  // and a hand-kept copy would not cover it.
  it.each(blockedNSFWOverridable as string[])('soft tier: %s IS overridable', (word) => {
    expect(isSoftBlock([trigger('nsfw_blocklist', word)])).toBe(true);
  });

  it('every blocklist word outside the overridable file is hard', () => {
    const overridable = new Set(blockedNSFWOverridable as string[]);
    const leaked = (blockedNSFW as string[])
      .filter((w) => !overridable.has(w))
      .filter((w) => isSoftBlock([trigger('nsfw_blocklist', w)]));
    expect(leaked).toEqual([]);
  });

  it('an unrecognised matched word defaults to hard', () => {
    expect(isSoftBlock([trigger('nsfw_blocklist', 'some-new-term')])).toBe(false);
    expect(isSoftBlock([{ category: 'nsfw_blocklist', message: 'x' }])).toBe(false);
  });

  // An overridable entry missing from the main blocklist matches nothing, so it is
  // dead config that reads like coverage. Catches typos in the overridable file.
  it('every overridable entry exists in the main blocklist', () => {
    const main = new Set(blockedNSFW as string[]);
    const orphans = (blockedNSFWOverridable as string[]).filter((w) => !main.has(w));
    expect(orphans).toEqual([]);
  });
});

describe('a hard word anywhere in the prompt beats an overridable one', () => {
  // `auditPromptEnriched` used to report the FIRST blocklist match in file order.
  // `daughter` is entry 23 of 191, so "daughter, <anything below it>" reported the
  // soft `daughter` and offered a click-through — one overridable word was a
  // universal override key for most of the hard tier.
  it.each([
    ['daughter, rape', 'rape'],
    ['portrait of a woman, daughter, lolita', 'lolita'],
    ['nazi, nigger', 'nigger'],
    ['pee, bestiality', 'bestiality'],
    ['anorexic, pro-ana', 'pro-ana'],
    ['diaper, incest', 'incest'],
  ])('%s reports the hard word and is not overridable', (prompt, expected) => {
    const result = auditPromptEnriched(prompt);
    expect(result.success).toBe(false);
    expect(result.triggers[0].matchedWord).toBe(expected);
    expect(isSoftBlock(result.triggers)).toBe(false);
  });

  it('a prompt whose only blocklist match is overridable stays overridable', () => {
    const result = auditPromptEnriched('a portrait of my daughter');
    expect(result.success).toBe(false);
    expect(result.triggers[0].matchedWord).toBe('daughter');
    expect(isSoftBlock(result.triggers)).toBe(true);
  });
});

describe('minor_age has no override path', () => {
  // `minor_age` looks like a false-positive machine ("an 8 year old oak tree")
  // and was proposed for the soft set. It was rejected because it is also the
  // ONLY thing catching a suggestive-minor prompt that carries no explicit term:
  // `inappropriate_minor` requires an NSFW word, so these reach `minor_age` and
  // nothing else. Adding 'minor_age' to SOFT_BLOCK_CATEGORIES makes every case
  // below overridable.
  it.each([
    '12 year old girl, swimsuit, beach',
    '15 year old girl, bedroom, lying down',
    '13 year old, revealing outfit',
    'child, 9 years old, wet t-shirt',
    'teen, 16 years old, short skirt',
  ])('suggestive-minor prompt is blocked with no override: %s', (prompt) => {
    const result = auditPromptEnriched(prompt);
    expect(result.success).toBe(false);
    expect(isSoftBlock(result.triggers)).toBe(false);
  });

  it('an innocent age mention is also still hard — the known cost of keeping the above safe', () => {
    const result = auditPromptEnriched('an 8 year old oak tree in a field');
    expect(result.success).toBe(false);
    expect(result.triggers[0].category).toBe('minor_age');
    expect(isSoftBlock(result.triggers)).toBe(false);
  });
});
