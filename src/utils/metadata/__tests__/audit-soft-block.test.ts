import { describe, expect, it } from 'vitest';
import {
  auditPromptEnriched,
  isSoftBlock,
  type PromptTrigger,
  type PromptTriggerCategory,
} from '~/utils/metadata/audit';

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
  it.each<PromptTriggerCategory>(['nsfw_blocklist', 'profanity', 'external'])(
    '%s is soft',
    (category) => {
      expect(isSoftBlock([trigger(category)])).toBe(true);
    }
  );

  it.each<PromptTriggerCategory>([
    'minor_age',
    'poi',
    'inappropriate_minor',
    'inappropriate_poi',
    'harmful_combo',
  ])('%s is hard', (category) => {
    expect(isSoftBlock([trigger(category)])).toBe(false);
  });

  it('one hard trigger poisons an otherwise soft set', () => {
    expect(isSoftBlock([trigger('profanity'), trigger('poi')])).toBe(false);
  });

  it('an external category naming a minor stays hard', () => {
    expect(isSoftBlock([trigger('external', 'sexual/minors')])).toBe(false);
    expect(isSoftBlock([trigger('external', 'harassment')])).toBe(true);
  });

  it('an empty trigger set is hard — the over-length block reports no triggers', () => {
    expect(isSoftBlock([])).toBe(false);
    const overLength = auditPromptEnriched('a'.repeat(20001));
    expect(overLength.success).toBe(false);
    expect(isSoftBlock(overLength.triggers)).toBe(false);
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
