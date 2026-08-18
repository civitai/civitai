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

/**
 * The rail and the conversation view must agree on what a request is. They
 * disagreed once — the rail bucketed on `filteredAt` while the accept CTA keyed
 * on `status`, so a membership that was filtered while still `Joined` sat in
 * Requests with no way to accept it and no way out.
 */
describe('a filtered membership is always actionable', () => {
  const requestable = (m: { status: ChatMemberStatus; filteredAt: Date | null }) =>
    chatBucketFor(m) === 'Requests';

  it('lands in Requests from every status the mark can be applied to', () => {
    for (const status of [ChatMemberStatus.Invited, ChatMemberStatus.Joined]) {
      expect(requestable(member(status, NOW))).toBe(true);
    }
  });

  it('leaves Requests once the mark is cleared', () => {
    // Accepting clears `filteredAt`; so does replying. Either way the same
    // membership must bucket back to the inbox.
    expect(chatBucketFor(member(ChatMemberStatus.Joined, null))).toBe('Inbox');
    expect(chatBucketFor(member(ChatMemberStatus.Invited, null))).toBe('Inbox');
  });
});
