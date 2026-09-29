import { describe, expect, it } from 'vitest';
import { ViolationType } from '~/server/common/enums';
import { tosReasonUserMessage } from '~/server/common/tos-reasons';

describe('tosReasonUserMessage', () => {
  it('names the stricter standard for a school removal instead of asserting a minor', () => {
    const message = tosReasonUserMessage(ViolationType.SchoolNsfw);
    expect(message).toBe(
      'School settings are moderated more strictly, and this was removed under that stricter standard'
    );
    expect(message.toLowerCase()).not.toContain('minor');
  });

  it('falls back to the label for violations without a user-facing override', () => {
    expect(tosReasonUserMessage(ViolationType.Bestiality)).toBe('Bestiality');
  });

  it('falls back to the raw value when unmapped', () => {
    expect(tosReasonUserMessage('not-a-violation')).toBe('not-a-violation');
  });
});
