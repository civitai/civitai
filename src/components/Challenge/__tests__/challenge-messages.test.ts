import { describe, expect, it } from 'vitest';
import { challengeEndedMessage } from '~/components/Challenge/challenge-messages';

describe('challengeEndedMessage', () => {
  it('says judging was QUEUED when the challenge was handed to the completion job', () => {
    // The failure this exists to prevent: reporting winnersCount 0 on a queued challenge, which
    // reads as "judging ran and found nobody" and invites the moderator to click again.
    const message = challengeEndedMessage({ queued: true, winnersCount: 0 });

    expect(message).toMatch(/queued/i);
    expect(message).not.toMatch(/0 winner/);
  });

  it('reports the real count on the inline path, where the number means something', () => {
    expect(challengeEndedMessage({ queued: false, winnersCount: 3 })).toBe(
      'Challenge ended. 3 winner(s) selected.'
    );
  });

  it('reports a genuine zero on the inline path rather than hiding it', () => {
    // Inline and no winners is a real outcome the moderator needs to see.
    expect(challengeEndedMessage({ queued: false, winnersCount: 0 })).toMatch(/0 winner/);
  });

  it('requires the flag rather than defaulting it', () => {
    // `queued` is required on the type, so a caller cannot omit it and silently get the inline
    // message for a queued challenge. This pins the contract that makes that a compile error.
    // @ts-expect-error - omitting `queued` must not type-check
    expect(() => challengeEndedMessage({ winnersCount: 2 })).not.toThrow();
  });
});
