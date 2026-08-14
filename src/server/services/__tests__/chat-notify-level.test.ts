import { describe, expect, it } from 'vitest';
import { ChatNotifyLevel } from '~/shared/utils/prisma/enums';
import { shouldNotifyForMessage } from '~/shared/utils/chat';

/**
 * Per-conversation notification levels. `Mentions` is the interesting one: chat
 * has no mention parser, so the rule is a boundary-checked substring match, and
 * getting the boundary wrong means either missing your own name or ringing for
 * someone else's.
 */

const notify = (level: ChatNotifyLevel, content: string, username?: string | null) =>
  shouldNotifyForMessage({ level, content, username });

describe('shouldNotifyForMessage', () => {
  it('notifies for everything at All and nothing at None', () => {
    expect(notify(ChatNotifyLevel.All, 'anything', 'alicia')).toBe(true);
    expect(notify(ChatNotifyLevel.None, '@alicia look at this', 'alicia')).toBe(false);
  });

  it('matches a mention regardless of case or position', () => {
    expect(notify(ChatNotifyLevel.Mentions, '@alicia did you see this', 'alicia')).toBe(true);
    expect(notify(ChatNotifyLevel.Mentions, 'hey @Alicia', 'alicia')).toBe(true);
    expect(notify(ChatNotifyLevel.Mentions, 'ping @ALICIA please', 'AlIcIa')).toBe(true);
  });

  it('stays silent when unmentioned', () => {
    expect(notify(ChatNotifyLevel.Mentions, 'talking about alicia', 'alicia')).toBe(false);
    expect(notify(ChatNotifyLevel.Mentions, 'hey @bob', 'alicia')).toBe(false);
  });

  it('does not let a name prefix ring someone else', () => {
    // @alicia must not match a mention of @aliciaB — that is a different user.
    expect(notify(ChatNotifyLevel.Mentions, 'hey @aliciaB', 'alicia')).toBe(false);
    expect(notify(ChatNotifyLevel.Mentions, 'hey @alicia_2', 'alicia')).toBe(false);
    expect(notify(ChatNotifyLevel.Mentions, 'hey @alicia-2', 'alicia')).toBe(false);
  });

  it('keeps scanning past a near-miss to find a real mention', () => {
    // The first hit is @aliciaB; the rule must not stop there and report false.
    expect(notify(ChatNotifyLevel.Mentions, 'ask @aliciaB or @alicia', 'alicia')).toBe(true);
  });

  it('allows trailing punctuation, which is the same address', () => {
    expect(notify(ChatNotifyLevel.Mentions, '@alicia, thoughts?', 'alicia')).toBe(true);
    expect(notify(ChatNotifyLevel.Mentions, 'thanks @alicia!', 'alicia')).toBe(true);
    expect(notify(ChatNotifyLevel.Mentions, 'cc @alicia.', 'alicia')).toBe(true);
  });

  it('stays silent rather than falling back to notifying with no username', () => {
    // A level that cannot be evaluated must not degrade into All, or "only when
    // mentioned" would look broken to anyone who set it.
    expect(notify(ChatNotifyLevel.Mentions, '@alicia hello', undefined)).toBe(false);
    expect(notify(ChatNotifyLevel.Mentions, '@alicia hello', null)).toBe(false);
  });
});
