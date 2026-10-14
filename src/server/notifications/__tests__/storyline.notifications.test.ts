import { describe, expect, it } from 'vitest';
import { notBlockedBetween } from '~/server/notifications/base.notifications';
import { storylineNotifications } from '~/server/notifications/storyline.notifications';
import { notificationProcessors } from '~/server/notifications/utils.notifications';

type Def = (typeof storylineNotifications)['storyline-continuation-submitted'];
const defs = storylineNotifications as Record<string, Def>;
const TYPES = Object.keys(storylineNotifications);

const LAST_SENT = '2026-10-13 00:00:00';
const query = async (type: string) =>
  (await defs[type].prepareQuery!({
    lastSent: LAST_SENT,
    lastSentDate: new Date(0),
    clickhouse: undefined,
  })) as string;

const message = (type: string, details: Record<string, unknown>) =>
  defs[type].prepareMessage({ type, details } as Parameters<Def['prepareMessage']>[0])!;

/**
 * Per type: who receives it, whose username the message names, which row status it reads, and
 * which column its time window is on. The SQL and the message are checked against the same row,
 * so a renamed details key or a swapped join fails here rather than reading "undefined".
 */
const CASES = [
  {
    type: 'storyline-continuation-submitted',
    recipient: 'ownerId',
    named: 'placerId',
    usernameKey: 'placerUsername',
    status: 'pending',
    window: 'createdAt',
    expected: 'tehalex86 wants to continue your storyline "The Patch"',
  },
  {
    type: 'storyline-continuation-approved',
    recipient: 'placerId',
    named: 'ownerId',
    usernameKey: 'ownerUsername',
    status: 'approved',
    window: 'resolvedAt',
    expected: 'tehalex86 added your chapter to "The Patch"',
  },
  {
    type: 'storyline-continuation-declined',
    recipient: 'placerId',
    named: 'ownerId',
    usernameKey: 'ownerUsername',
    status: 'declined',
    window: 'resolvedAt',
    expected: 'tehalex86 declined your continuation of "The Patch"',
  },
] as const;

describe('storyline continuation notifications', () => {
  it('registers exactly the three types with the notification job', () => {
    expect(CASES.map((c) => c.type).sort()).toEqual([...TYPES].sort());
    for (const type of TYPES) expect(notificationProcessors[type]).toBe(defs[type]);
  });

  it.each(CASES)('$type names the right people', async (c) => {
    const sql = await query(c.type);
    const other = c.recipient === 'ownerId' ? 'placerId' : 'ownerId';
    expect(sql).toMatch(new RegExp(String.raw`p\."${c.recipient}"\s+"userId"`));
    expect(sql).not.toMatch(new RegExp(String.raw`p\."${other}"\s+"userId"`));
    expect(sql).toContain(`JOIN "User" u ON u.id = p."${c.named}"`);
    expect(sql).toContain(`'${c.usernameKey}', u.username`);
  });

  it.each(CASES)('$type builds its message from keys the query emits', async (c) => {
    const sql = await query(c.type);
    for (const key of ['storylineId', 'storylineTitle', c.usernameKey])
      expect(sql).toContain(`'${key}', `);

    expect(
      message(c.type, { storylineId: 7, storylineTitle: 'The Patch', [c.usernameKey]: 'tehalex86' })
    ).toEqual({ message: c.expected, url: '/storylines/7' });
  });

  it.each(CASES)('$type reads only its own storyline rows, once each', async (c) => {
    const sql = await query(c.type);
    expect(sql).toContain(`p.surface = 'storyline'`);
    expect(sql).toContain(`p."targetType" = 'post'`);
    expect(sql.match(/p\.status = '\w+'/g)).toEqual([`p.status = '${c.status}'`]);
    expect(sql).toContain(`CONCAT('${c.type}:',"placementId")`);
    expect(sql).toContain(
      `NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = data."userId" AND type = '${c.type}')`
    );
  });

  // An answer given after the last run to a continuation submitted before it still has to be sent,
  // so each type windows on its own actor's moment.
  it.each(CASES)('$type windows on $window', async (c) => {
    const sql = await query(c.type);
    expect(sql).toContain(`p."${c.window}" > '${LAST_SENT}'`);
    const otherWindow = c.window === 'createdAt' ? 'resolvedAt' : 'createdAt';
    expect(sql).not.toContain(`p."${otherWindow}" >`);
  });

  it.each(CASES)(
    '$type skips taken-down storylines, blocked pairs, and foreign owners',
    async (c) => {
      const sql = await query(c.type);
      expect(sql).toContain(`NOT s."tosViolation"`);
      // The submission goes to the placement's owner as "your storyline"; that is only true when the
      // owner is the storyline's.
      expect(sql).toContain(`p."ownerId" = s."userId"`);
      // Recipient first: a Hide counts only in the recipient's own direction.
      expect(sql).toContain(notBlockedBetween(`p."${c.recipient}"`, `p."${c.named}"`));
    }
  );

  it.each(CASES)('$type says nothing about Buzz', (c) => {
    const { message: text } = message(c.type, {
      storylineId: 7,
      storylineTitle: 'The Patch',
      [c.usernameKey]: 'tehalex86',
    });
    expect(text).not.toMatch(/buzz|refund|\bfee\b/i);
  });
});
