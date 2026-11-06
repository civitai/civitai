import { describe, expect, it } from 'vitest';
import { notBlockedBetween } from '~/server/notifications/base.notifications';
import {
  storylineNotifications,
  storylineOwnerNotifications,
} from '~/server/notifications/storyline.notifications';
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
    // Announced when it becomes reviewable: a readied continuation by readyAt, any other by createdAt.
    window: `COALESCE((p.data->>'readyAt')::timestamptz AT TIME ZONE 'UTC', p."createdAt")`,
    expected: 'tehalex86 wants to continue your storyline "The Patch"',
    url: '/user/placements?type=storyline&tab=received',
  },
  {
    type: 'storyline-continuation-approved',
    recipient: 'placerId',
    named: 'ownerId',
    usernameKey: 'ownerUsername',
    status: 'approved',
    window: 'p."resolvedAt"',
    expected: 'tehalex86 added your chapter to "The Patch"',
    url: '/storylines/7',
  },
  {
    type: 'storyline-continuation-declined',
    recipient: 'placerId',
    named: 'ownerId',
    usernameKey: 'ownerUsername',
    status: 'declined',
    window: 'p."resolvedAt"',
    expected: 'tehalex86 declined your continuation of "The Patch"',
    url: '/storylines/7',
  },
] as const;

describe('storyline continuation notifications', () => {
  it('registers exactly the three types with the notification job', () => {
    expect(CASES.map((c) => c.type).sort()).toEqual([...TYPES].sort());
    for (const type of TYPES) expect(notificationProcessors[type]).toBe(defs[type]);
  });

  it('tells the owner the rating their storyline was raised to', () => {
    const def = storylineOwnerNotifications['storyline-ceiling-raised'];
    expect(notificationProcessors['storyline-ceiling-raised']).toBe(def);
    expect(
      def.prepareMessage({
        type: 'storyline-ceiling-raised',
        details: {
          storylineId: 7,
          storylineTitle: 'The Patch',
          maxNsfwLevel: 4,
        },
      } as Parameters<typeof def.prepareMessage>[0])
    ).toEqual({
      message: '"The Patch" now allows up to R, the rating of its first chapter',
      url: '/storylines/7',
    });
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
    expect(sql).toContain(`'storylineId', s.id`);
    expect(sql).toContain(`'storylineTitle', s.title`);
    expect(sql).toContain(`'${c.usernameKey}', u.username`);
    // The detail fetcher reads this key for the avatar of the person named.
    expect(sql).toContain(`'${c.named}', p."${c.named}"`);

    expect(
      message(c.type, { storylineId: 7, storylineTitle: 'The Patch', [c.usernameKey]: 'tehalex86' })
    ).toEqual({ message: c.expected, url: c.url });
  });

  it.each(CASES)('$type reads only its own storyline rows, once each', async (c) => {
    const sql = await query(c.type);
    expect(sql).toContain(`JOIN "StorylineChapter" c ON c."postId" = p."targetId"`);
    expect(sql).toContain(`JOIN "Storyline" s ON s.id = c."storylineId"`);
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
  it.each(CASES)('$type windows on its own moment', async (c) => {
    const sql = await query(c.type);
    expect(sql.match(/> '2026-10-13 00:00:00'/g)).toHaveLength(1);
    expect(sql).toContain(`${c.window} > '${LAST_SENT}'`);
  });

  it('never announces a continuation still waiting to become reviewable', async () => {
    expect(await query('storyline-continuation-submitted')).toContain(
      `AND NOT (p.data ? 'awaitingReadiness')`
    );
  });

  it('does not credit the owner with an approval the system made', async () => {
    expect(await query('storyline-continuation-approved')).toContain(
      `'byOwner', p."resolvedById" IS NOT NULL`
    );
    const details = { storylineId: 7, storylineTitle: 'The Patch', ownerUsername: 'tehalex86' };
    expect(message('storyline-continuation-approved', { ...details, byOwner: false }).message).toBe(
      'Your chapter was added to "The Patch"'
    );
    expect(message('storyline-continuation-approved', { ...details, byOwner: true }).message).toBe(
      'tehalex86 added your chapter to "The Patch"'
    );
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

  it('announces only declines the owner made', async () => {
    expect(await query('storyline-continuation-declined')).toContain(`AND NOT p."feeWaived"`);
    expect(await query('storyline-continuation-approved')).not.toContain('feeWaived');
  });

  it.each(CASES)('$type says nothing about Buzz', (c) => {
    const { message: text } = message(c.type, {
      storylineId: 7,
      storylineTitle: 'The Patch',
      [c.usernameKey]: 'tehalex86',
    });
    expect(text).not.toMatch(/buzz|refund|\bfee\b/i);
  });
});
