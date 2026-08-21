import { describe, expect, it } from 'vitest';
import { getMessageRowFlags } from '~/components/Chat/message-grouping';
import { ChatMessageType } from '~/shared/utils/prisma/enums';

const ALICE = 11;
const BOB = 22;
const SYSTEM = -1;

// Local rather than UTC: isSameDay reads the local calendar date, so a UTC
// literal would put the day boundary in a different place per machine.
const at = (day: number, hour: number, minute: number, second = 0) =>
  new Date(2026, 7, day, hour, minute, second);

const msg = (userId: number, createdAt: Date) => ({
  userId,
  createdAt,
  contentType: ChatMessageType.Markdown,
});

/** The unfurl the server writes as its own row, attributed to the system user. */
const embed = (createdAt: Date) => ({
  userId: SYSTEM,
  createdAt,
  contentType: ChatMessageType.Embed,
});

describe('getMessageRowFlags', () => {
  it('draws one header for a run and repeats it when the sender changes', () => {
    const flags = getMessageRowFlags([
      msg(ALICE, at(20, 10, 0)),
      msg(ALICE, at(20, 10, 1)),
      msg(BOB, at(20, 10, 2)),
    ]);

    expect(flags.map((f) => f.showHeader)).toEqual([true, false, true]);
  });

  it('starts a new run once the sender has been quiet for an hour', () => {
    const flags = getMessageRowFlags([
      msg(ALICE, at(20, 10, 0)),
      msg(ALICE, at(20, 10, 59)),
      msg(ALICE, at(20, 12, 0)),
    ]);

    expect(flags.map((f) => f.showHeader)).toEqual([true, false, true]);
  });

  it('spaces every run but the first, so the top of the pane has no dangling gap', () => {
    const flags = getMessageRowFlags([
      msg(ALICE, at(20, 10, 0)),
      msg(ALICE, at(20, 10, 1)),
      msg(BOB, at(20, 10, 2)),
    ]);

    expect(flags.map((f) => f.isNewSender)).toEqual([false, false, true]);
  });

  it('keeps a sender in one run across the embed their own link produced', () => {
    const flags = getMessageRowFlags([
      msg(ALICE, at(20, 10, 0)),
      embed(at(20, 10, 0, 1)),
      msg(ALICE, at(20, 10, 0, 30)),
    ]);

    // Reverting the embed skip makes the third row's header come back, because the
    // embed leaves -1 as the previous sender.
    expect(flags[2].showHeader).toBe(false);
    expect(flags[2].isNewSender).toBe(false);
  });

  it('leaves the day chip on the first real message of the day, not on the embed', () => {
    const flags = getMessageRowFlags([
      msg(ALICE, at(19, 23, 59)),
      embed(at(20, 0, 0, 10)),
      msg(BOB, at(20, 0, 0, 30)),
    ]);

    // The chip is suppressed on system rows at render, so an embed that consumed
    // it would leave the day change unmarked entirely.
    expect(flags[2].showDayChip).toBe(true);
  });

  it('marks the very first message with a day chip', () => {
    const flags = getMessageRowFlags([msg(ALICE, at(20, 10, 0))]);

    expect(flags[0].showDayChip).toBe(true);
  });

  it('returns one entry per message, in order', () => {
    const messages = [msg(ALICE, at(20, 10, 0)), embed(at(20, 10, 0, 1)), msg(BOB, at(20, 10, 5))];

    expect(getMessageRowFlags(messages)).toHaveLength(messages.length);
  });
});
