import { describe, expect, it } from 'vitest';
import { deriveMuteColumns } from '~/shared/utils/chat';
import { ChatNotifyLevel } from '~/shared/utils/prisma/enums';
import { shouldNotifyForMessage } from '~/shared/utils/chat';
import { EMOJI_JUMBO_LIMIT, emojiOnlyCount, isJumboEmojiText } from '~/shared/constants/base-emoji';

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

/**
 * Jumbo sizing. `\p{Emoji_Component}` covers ASCII digits, `#` and `*`, so a
 * code-point test renders "🔥 100" — an ordinary message — at 38px, splits one
 * ZWJ family into four, and never fires for flags or keycaps.
 */
describe('isJumboEmojiText', () => {
  it('treats a multi-codepoint emoji as one', () => {
    expect(emojiOnlyCount('👨‍👩‍👧‍👦')).toBe(1);
    expect(emojiOnlyCount('👩‍🚀')).toBe(1);
    expect(emojiOnlyCount('👍🏽')).toBe(1);
    // Two families used to count 8 and fall past the 6 cap, so they did NOT jumbo.
    expect(isJumboEmojiText('👨‍👩‍👧‍👦👨‍👩‍👧‍👦')).toBe(true);
  });

  it('jumbos flags and keycaps, which never fired before', () => {
    expect(isJumboEmojiText('🇺🇸')).toBe(true);
    expect(isJumboEmojiText('1️⃣')).toBe(true);
  });

  it('does not jumbo ordinary text that merely contains digits or symbols', () => {
    for (const text of ['🔥 100', '⭐ 2000', '#🔥', 'hello', '']) {
      expect(isJumboEmojiText(text)).toBe(false);
    }
  });

  it('still jumbos a short run of plain emoji, and stops past the cap', () => {
    expect(isJumboEmojiText('🎉 🎉')).toBe(true);
    expect(isJumboEmojiText('🎉'.repeat(EMOJI_JUMBO_LIMIT))).toBe(true);
    expect(isJumboEmojiText('🎉'.repeat(EMOJI_JUMBO_LIMIT + 1))).toBe(false);
  });
});

/**
 * Both mute columns have to move together, and the one the caller named has to
 * be the one that moves.
 *
 * The regression this guards is silent in every way that matters: deriving both
 * columns unconditionally sent `undefined` for whichever field the request
 * actually carried, Prisma read that as "leave this column alone", the mutation
 * returned 200, and the setting snapped back on the next render with no error
 * anywhere. Asserting the mirror alone would not have caught it — the mirror
 * was the half that kept working.
 */
describe('deriveMuteColumns', () => {
  it('writes the level it was given, and mirrors it to isMuted', () => {
    expect(deriveMuteColumns({ notifyLevel: ChatNotifyLevel.Mentions })).toEqual({
      notifyLevel: ChatNotifyLevel.Mentions,
      isMuted: false,
    });
    expect(deriveMuteColumns({ notifyLevel: ChatNotifyLevel.None })).toEqual({
      notifyLevel: ChatNotifyLevel.None,
      isMuted: true,
    });
  });

  it('writes the mute it was given, and mirrors it to a level', () => {
    // `false` has to survive the fallback: an unmute that resolves to undefined
    // leaves the conversation silent forever.
    expect(deriveMuteColumns({ isMuted: false })).toEqual({
      isMuted: false,
      notifyLevel: ChatNotifyLevel.All,
    });
    expect(deriveMuteColumns({ isMuted: true })).toEqual({
      isMuted: true,
      notifyLevel: ChatNotifyLevel.None,
    });
  });

  it('touches neither column when the change is about something else', () => {
    // Every other field of a membership update comes through here too; a status
    // or pin change must not drag a mute along with it.
    expect(deriveMuteColumns({})).toEqual({ isMuted: undefined, notifyLevel: undefined });
  });

  it('keeps an explicit pair intact rather than re-deriving either half', () => {
    expect(deriveMuteColumns({ isMuted: true, notifyLevel: ChatNotifyLevel.Mentions })).toEqual({
      isMuted: true,
      notifyLevel: ChatNotifyLevel.Mentions,
    });
  });
});
