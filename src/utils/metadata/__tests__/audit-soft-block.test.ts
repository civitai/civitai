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
  it.each<PromptTriggerCategory>(['minor_age', 'nsfw_blocklist', 'profanity', 'external'])(
    '%s is soft',
    (category) => {
      expect(isSoftBlock([trigger(category)])).toBe(true);
    }
  );

  it.each<PromptTriggerCategory>([
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

describe('auditPromptEnriched — hard checks must be evaluated first', () => {
  // Every check returns on first match, so ordering decides the reported category
  // and therefore the severity. If `minor_age` ran first (as it did before the
  // soft/hard split) it would short-circuit and report the SOFT category here,
  // making an explicitly sexual minor prompt click-through.
  it('a sexual minor prompt reports inappropriate_minor, not the soft minor_age', () => {
    const result = auditPromptEnriched('17 year old, nude');
    expect(result.success).toBe(false);
    expect(result.triggers[0].category).toBe('inappropriate_minor');
    expect(isSoftBlock(result.triggers)).toBe(false);
  });

  it('a bare age mention with no sexual context stays soft', () => {
    const result = auditPromptEnriched('an 8 year old oak tree in a field');
    expect(result.success).toBe(false);
    expect(result.triggers[0].category).toBe('minor_age');
    expect(isSoftBlock(result.triggers)).toBe(true);
  });
});
