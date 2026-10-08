import { describe, expect, it } from 'vitest';
import { ViolationType } from '~/server/common/enums';
import { TOS_REASONS, tosReasonUserMessage } from '~/server/common/tos-reasons';

describe('tosReasonUserMessage', () => {
  it('names the stricter standard for a school removal instead of asserting a minor', () => {
    const message = tosReasonUserMessage(ViolationType.SchoolNsfw);
    expect(message).toBe(
      'School settings are moderated more strictly, and this was removed under that stricter standard'
    );
    expect(message.toLowerCase()).not.toContain('minor');
  });

  it('words a minor-with-violence removal without the mature-context accusation', () => {
    // The fused "Minor in Mature Context" labels read to the owner as a CSAM accusation; this reason
    // exists so violence involving a young-looking character is not filed or worded that way.
    const message = tosReasonUserMessage(ViolationType.MinorViolence);
    expect(message).toBe(
      'Violence against, or implied harm to, characters who appear young is not allowed'
    );
  });

  it('offers minor-with-violence in the moderator picker', () => {
    expect(TOS_REASONS.map((r) => r.value)).toContain(ViolationType.MinorViolence);
  });

  it('falls back to the label for violations without a user-facing override', () => {
    expect(tosReasonUserMessage(ViolationType.Bestiality)).toBe('Bestiality');
  });

  it('falls back to the raw value when unmapped', () => {
    expect(tosReasonUserMessage('not-a-violation')).toBe('not-a-violation');
  });
});
