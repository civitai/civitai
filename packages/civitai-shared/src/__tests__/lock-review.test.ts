import { describe, expect, it } from 'vitest';
import { lockReviewRulingMessage, requestableLocks } from '../lock-review';

describe('requestableLocks', () => {
  it.each(['poi', 'minor'])('offers the other locked settings while %s is locked off', (mark) => {
    expect(
      requestableLocks({
        lockedProperties: [mark, 'sfwOnly', 'nsfw', 'category'],
        poi: false,
        minor: false,
      })
    ).toEqual(['nsfw', 'sfwOnly', 'category']);
  });

  it('offers them with both poi and minor locked off', () => {
    expect(
      requestableLocks({ lockedProperties: ['poi', 'minor', 'nsfw'], poi: false, minor: false })
    ).toEqual(['nsfw']);
  });

  it('offers the other locked settings while poi and minor are locked but unset', () => {
    expect(requestableLocks({ lockedProperties: ['poi', 'minor', 'tags'] })).toEqual(['tags']);
    expect(
      requestableLocks({ lockedProperties: ['poi', 'minor', 'tags'], poi: null, minor: null })
    ).toEqual(['tags']);
  });

  it.each([{ poi: true }, { minor: true }])('offers nothing on a model marked %o', (mark) => {
    expect(
      requestableLocks({ lockedProperties: ['poi', 'minor', 'nsfw', 'tags'], ...mark })
    ).toEqual([]);
    expect(requestableLocks({ lockedProperties: ['nsfw', 'tags'], ...mark })).toEqual([]);
  });

  it('never offers poi or minor themselves', () => {
    expect(
      requestableLocks({ lockedProperties: ['poi', 'minor'], poi: false, minor: false })
    ).toEqual([]);
  });
});

describe('lockReviewRulingMessage — a rejection', () => {
  const DECLINED =
    'Your request to review the locked settings on your model was declined, so those settings stay locked.';
  // The cooldown is 30 days, so each resolution date below lands on the day named after it.
  const after = (resolvedAt: string, reason?: string | null) =>
    lockReviewRulingMessage(false, [], { reason, resolvedAt: new Date(resolvedAt) });

  it.each([
    ['2026-10-02T12:00:00Z', 'November 1st'],
    ['2026-10-03T12:00:00Z', 'November 2nd'],
    ['2026-10-04T12:00:00Z', 'November 3rd'],
    ['2026-10-12T12:00:00Z', 'November 11th'],
    ['2026-10-13T12:00:00Z', 'November 12th'],
    ['2026-10-14T12:00:00Z', 'November 13th'],
    ['2026-10-23T12:00:00Z', 'November 22nd'],
  ])('dates the next request 30 days after a ruling on %s: %s', (resolvedAt, day) => {
    expect(after(resolvedAt)).toBe(`${DECLINED} You can request another review after ${day}.`);
  });

  it('names the year when the next request falls in a later one', () => {
    expect(after('2026-12-15T12:00:00Z')).toBe(
      `${DECLINED} You can request another review after January 14th, 2027.`
    );
  });

  it('gives the reason the moderator picked', () => {
    const closing = ' You can request another review after November 15th.';
    expect(after('2026-10-16T12:00:00Z', 'lock-stands')).toBe(
      `A moderator reviewed your model and found the locked settings correct for it.${closing}`
    );
    expect(after('2026-10-16T12:00:00Z', 'sexual-purpose')).toBe(
      `A moderator reviewed your model and found that its main purpose is sexual content, so it keeps the mature setting.${closing}`
    );
  });

  it('keeps the neutral line for Other, no reason, or a reason it does not know', () => {
    const neutral = `${DECLINED} You can request another review after November 15th.`;
    for (const reason of ['other', null, undefined, 'not-a-reason'])
      expect(after('2026-10-16T12:00:00Z', reason)).toBe(neutral);
  });

  it('reads a stored notice, whose time is an ISO string', () => {
    expect(lockReviewRulingMessage(false, [], { resolvedAt: '2026-10-16T12:00:00.000Z' })).toBe(
      `${DECLINED} You can request another review after November 15th.`
    );
    expect(lockReviewRulingMessage(false, [], { resolvedAt: 'garbage' })).toBe(DECLINED);
  });

  it("names no year when the next request is in the ruling's own year, whatever year it is now", () => {
    expect(after('2020-03-01T12:00:00Z')).toBe(
      `${DECLINED} You can request another review after March 31st.`
    );
  });

  it('leaves out the date when it has no resolution time, as on a notice filed before it was stored', () => {
    expect(lockReviewRulingMessage(false)).toBe(DECLINED);
  });
});
