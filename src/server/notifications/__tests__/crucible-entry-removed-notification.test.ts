import { describe, expect, it } from 'vitest';
import { crucibleNotifications } from '~/server/notifications/crucible.notifications';

describe('crucible-entry-removed message', () => {
  const message = (details: Record<string, unknown>) =>
    crucibleNotifications['crucible-entry-removed'].prepareMessage({
      details: { crucibleId: 7, crucibleName: 'Neon', ...details },
    } as never)!.message;

  it("names the owner and the reason when the crucible's owner removed it", () => {
    const text = message({ removedBy: 'owner', reason: 'Low effort or spam', refundedAmount: 0 });

    expect(text).toContain("The crucible's owner removed your entry");
    expect(text).toContain('Reason: Low effort or spam.');
    expect(text).not.toContain('moderator');
  });

  it('keeps the moderator wording, with no reason, when a moderator removed it', () => {
    expect(message({ refundedAmount: 0 })).toBe(
      'A moderator removed your entry from the crucible "Neon".'
    );
  });

  it('adds the refund after the reason', () => {
    expect(message({ removedBy: 'owner', reason: 'Off-topic', refundedAmount: 1500 })).toBe(
      'The crucible\'s owner removed your entry from the crucible "Neon". Reason: Off-topic. Your 1,500 Buzz entry fee was refunded.'
    );
  });
});
