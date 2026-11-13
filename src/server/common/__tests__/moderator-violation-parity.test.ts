import { describe, expect, it } from 'vitest';
import { ViolationType } from '~/server/common/enums';
import { tosReasonUserMessage } from '~/server/common/tos-reasons';
import {
  VIOLATION_TYPES,
  violationUserMessage,
} from '../../../../apps/moderator/src/lib/violations';

// The moderator app hand-mirrors `ViolationType` and posts it to `/api/mod/remove-images`, whose
// z.enum refuses a value it does not know. Drift here is a removal that 400s, or an owner told two
// different things depending on which app removed their image.
describe('moderator app violation mirror', () => {
  it('offers exactly the violation types the main app accepts', () => {
    expect([...VIOLATION_TYPES].sort()).toEqual(Object.values(ViolationType).sort());
  });

  it.each(Object.values(ViolationType))('words %s the same to the owner in both apps', (v) => {
    expect(violationUserMessage(v)).toBe(tosReasonUserMessage(v));
  });
});
