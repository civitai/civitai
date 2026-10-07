import { describe, expect, it } from 'vitest';
import { shouldPromptTosReacceptance, tosAcceptanceOutcome } from '~/hooks/tos-reacceptance-prompt';

const offered = { data: { tosReacceptRequired: true } };

describe('shouldPromptTosReacceptance', () => {
  it('opens the Terms for a refusal that offers them', () => {
    expect(shouldPromptTosReacceptance(offered, false)).toBe(true);
  });

  it('does not reopen them once the user has accepted', () => {
    expect(shouldPromptTosReacceptance(offered, true)).toBe(false);
  });

  it('ignores refusals that do not offer them', () => {
    expect(shouldPromptTosReacceptance({ data: {} }, false)).toBe(false);
    expect(shouldPromptTosReacceptance(null, false)).toBe(false);
  });
});

describe('tosAcceptanceOutcome', () => {
  it('says the account stays restricted, never that it was unmuted', () => {
    const outcome = tosAcceptanceOutcome({ accepted: true });
    expect(outcome.accepted).toBe(true);
    expect(outcome.notice?.title).toBe('Your account is still restricted');
    expect(outcome.notice?.message).not.toMatch(/unmuted|has been lifted|unblocked/i);
  });

  it('shows nothing and stays armed when the acceptance did not record', () => {
    expect(tosAcceptanceOutcome(undefined)).toEqual({ accepted: false, notice: null });
    expect(tosAcceptanceOutcome({})).toEqual({ accepted: false, notice: null });
  });
});
