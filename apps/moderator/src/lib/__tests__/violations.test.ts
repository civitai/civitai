import { describe, expect, it } from 'vitest';
import { violationUserMessage } from '$lib/violations';

describe('violationUserMessage', () => {
  it('names the stricter standard for a school removal instead of asserting a minor', () => {
    const message = violationUserMessage('schoolNsfw');
    expect(message).toBe(
      'School settings are moderated more strictly, and this was removed under that stricter standard'
    );
    expect(message.toLowerCase()).not.toContain('minor');
  });

  it('words a minor-with-violence removal without the mature-context accusation', () => {
    const message = violationUserMessage('minorViolence');
    expect(message).toBe(
      'Violence against, or implied harm to, characters who appear young is not allowed'
    );
  });

  it('falls back to the label for violations without a user-facing override', () => {
    expect(violationUserMessage('bestiality')).toBe('Bestiality');
  });
});
