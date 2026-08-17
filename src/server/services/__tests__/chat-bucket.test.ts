import { describe, expect, it } from 'vitest';
import { ChatMemberStatus } from '~/shared/utils/prisma/enums';
import { chatBucketFor } from '~/shared/utils/chat';

/**
 * Which rail bucket a membership lands in.
 *
 * The rule keyed on `Invited && filteredAt`, which silently dropped every
 * re-filtered conversation into the inbox: deleting a chat and being contacted
 * again marks the membership filtered while it is still `Joined`, and that case
 * matched nothing.
 */
const member = (status: ChatMemberStatus, filteredAt: Date | null = null) => ({
  status,
  filteredAt,
});

const NOW = new Date('2026-08-17T12:00:00Z');

describe('chatBucketFor', () => {
  it('puts an ordinary accepted chat in the inbox', () => {
    expect(chatBucketFor(member(ChatMemberStatus.Joined))).toBe('Inbox');
  });

  it('puts an unfiltered invitation in the inbox, not Requests', () => {
    // Only policy-filtered invitations are requests; a plain invite from someone
    // who passes your policy still belongs in the inbox.
    expect(chatBucketFor(member(ChatMemberStatus.Invited))).toBe('Inbox');
  });

  it('treats a filtered membership as a request whatever its status', () => {
    expect(chatBucketFor(member(ChatMemberStatus.Invited, NOW))).toBe('Requests');
    // The regression: a chat you had accepted, then deleted, then were contacted
    // in again is filtered while still Joined.
    expect(chatBucketFor(member(ChatMemberStatus.Joined, NOW))).toBe('Requests');
  });

  it('keeps archived states archived even when filtered', () => {
    for (const status of [
      ChatMemberStatus.Ignored,
      ChatMemberStatus.Left,
      ChatMemberStatus.Kicked,
    ]) {
      expect(chatBucketFor(member(status))).toBe('Archived');
      // Archiving is the more specific intent; a filter mark must not drag a
      // conversation the user filed away back into Requests.
      expect(chatBucketFor(member(status, NOW))).toBe('Archived');
    }
  });
});
