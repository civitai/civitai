import { describe, expect, it } from 'vitest';
import { storylineNotifications } from '~/server/notifications/storyline.notifications';

type Def = (typeof storylineNotifications)['storyline-continuation-submitted'];
const defs = storylineNotifications as Record<string, Def>;

const query = async (type: string) =>
  (await defs[type].prepareQuery!({
    lastSent: '2026-10-13 00:00:00',
    lastSentDate: new Date(0),
    clickhouse: undefined,
  })) as string;

const message = (type: string, details: Record<string, unknown>) =>
  defs[type].prepareMessage({ type, details } as Parameters<Def['prepareMessage']>[0])!;

describe('storyline continuation notifications', () => {
  it('tells the storyline owner a continuation is waiting, and links to the storyline', () => {
    expect(
      message('storyline-continuation-submitted', {
        storylineId: 7,
        storylineTitle: 'The Patch',
        placerUsername: 'tehalex86',
      })
    ).toEqual({
      message: 'tehalex86 wants to continue your storyline "The Patch"',
      url: '/storylines/7',
    });
  });

  it('tells the contributor the outcome, approved and declined alike', () => {
    const details = { storylineId: 7, storylineTitle: 'The Patch', ownerUsername: 'Sillycat83' };
    expect(message('storyline-continuation-approved', details)).toEqual({
      message: 'Sillycat83 added your chapter to "The Patch"',
      url: '/storylines/7',
    });
    expect(message('storyline-continuation-declined', details)).toEqual({
      message: 'Sillycat83 declined your continuation of "The Patch"',
      url: '/storylines/7',
    });
  });

  // A swap of the recipient column is green everywhere else: the owner would be told they want to
  // continue their own story, or the contributor would never hear back.
  it.each([
    ['storyline-continuation-submitted', 'ownerId'],
    ['storyline-continuation-approved', 'placerId'],
    ['storyline-continuation-declined', 'placerId'],
  ])('%s goes to the %s', async (type, recipient) => {
    const sql = await query(type);
    expect(sql).toMatch(new RegExp(String.raw`p\."${recipient}"\s+"userId"`));
    const other = recipient === 'ownerId' ? 'placerId' : 'ownerId';
    expect(sql).not.toMatch(new RegExp(String.raw`p\."${other}"\s+"userId"`));
  });

  it.each([
    ['storyline-continuation-submitted', 'pending'],
    ['storyline-continuation-approved', 'approved'],
    ['storyline-continuation-declined', 'declined'],
  ])(
    '%s reads only %s storyline rows, under its own dedupe key and toggle',
    async (type, status) => {
      const sql = await query(type);
      expect(sql).toMatch(/p\.surface = 'storyline'/);
      expect(sql).toContain(`p.status = '${status}'`);
      expect(sql).toContain(`CONCAT('${type}:',"placementId")`);
      expect(sql).toContain(
        `NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = data."userId" AND type = '${type}')`
      );
    }
  );

  // An answer given before the last run on a continuation submitted earlier still has to be sent,
  // so the outcome types window on the answer, never on the submission.
  it.each(['storyline-continuation-approved', 'storyline-continuation-declined'])(
    '%s windows on resolvedAt',
    async (type) => {
      const sql = await query(type);
      expect(sql).toContain(`p."resolvedAt" > '2026-10-13 00:00:00'`);
      expect(sql).not.toContain(`p."createdAt" >`);
    }
  );
});
