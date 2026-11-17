import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  renderNoticeMessage,
  sendSystemNoticesInput,
  type SendSystemNoticesInput,
  type SendSystemNoticesResult,
} from '@civitai/notifications';

vi.mock('~/server/jobs/job', () => ({
  createJob: (_n: string, _c: string, fn: unknown) => fn,
  UNRUNNABLE_JOB_CRON: '0 0 31 2 *',
}));
vi.mock('~/server/events/birthday2026.event', () => ({ birthday2026: {} }));
vi.mock('~/server/notifications/client', () => ({ notifications: {} }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  getIdleHatOwners,
  getPushableUserIds,
  IDLE_HAT_HOLDOUT_SEND_ID,
  IDLE_HAT_NUDGE_LEGACY_SEND_ID,
  IDLE_HAT_REMINDER_SEND_ID,
  isInHoldout,
  runIdleHatNudge,
  type IdleHatOwner,
} from '~/server/jobs/birthday2026-idle-hat-nudge';

const DURING = new Date('2026-11-02T12:00:00Z');

function setup(
  owners: IdleHatOwner[],
  { now = DURING, assigned = 'Green', pushable = [] as number[] } = {}
) {
  const calls: SendSystemNoticesInput[] = [];
  const getUserTeam = vi.fn(async (_userId: number) => assigned);
  const sendSystemNotices = vi.fn(async (input: SendSystemNoticesInput) => {
    // The real client parses with this schema and throws on a mismatch; so does this fake.
    const parsed = sendSystemNoticesInput.parse(input);
    calls.push(input);
    const recipients = parsed.recipients ?? [];
    return {
      sendId: parsed.sendId,
      mode: parsed.mode,
      requested: recipients.length,
      counts: { queued: recipients.length },
      samples: recipients.map((r) => ({
        userId: r.userId,
        message: renderNoticeMessage(parsed.message, r.params),
        url: parsed.url,
      })),
      dropped: {},
    } as unknown as SendSystemNoticesResult;
  });
  const run = (query: Record<string, string> = {}) =>
    runIdleHatNudge(query, {
      getOwners: async () => owners,
      getPushable: async (ids) => ids.filter((id) => pushable.includes(id)),
      getUserTeam,
      sendSystemNotices,
      now: () => now,
    });
  return { run, calls, getUserTeam, sendSystemNotices };
}

describe('birthday2026 idle hat nudge', () => {
  it('dry-runs unless mode=send is passed', async () => {
    const { run, calls } = setup([{ userId: 1, teams: ['Pink'] }]);
    await run();
    await run({ mode: 'send' });
    expect(calls.map((c) => c.mode)).toEqual(['dry-run', 'send']);
  });

  it('sends one notice per owner under one sendId, naming their team, linking the event page', async () => {
    const { run, calls } = setup([
      { userId: 1, teams: ['Pink'] },
      { userId: 2, teams: ['Blue'] },
    ]);
    const result = await run({ mode: 'send' });

    expect(calls).toHaveLength(1);
    expect(calls[0].sendId).toBe(IDLE_HAT_REMINDER_SEND_ID);
    expect(calls[0].type).toBe('event-reminder');
    expect(calls[0].url).toBe('/events/birthday2026');
    expect(calls[0].recipients).toEqual([
      { userId: 1, params: { team: 'Pink' } },
      { userId: 2, params: { team: 'Blue' } },
    ]);
    expect(result.samples).toEqual([
      "Your birthday hat isn't on anything yet. Put it on an image, model or article to score for Team Pink.",
      "Your birthday hat isn't on anything yet. Put it on an image, model or article to score for Team Blue.",
    ]);
  });

  it('holds out about a tenth of the owners push would reach, as an unpushable notice with the same copy', async () => {
    const ids = Array.from({ length: 400 }, (_, i) => i + 1);
    const pushable = ids.filter((id) => id % 2 === 0);
    const { run, calls } = setup(
      ids.map((userId) => ({ userId, teams: ['Pink'] })),
      { pushable }
    );
    const result = await run({ mode: 'send' });

    const [reminder, holdout] = calls;
    expect(holdout).toMatchObject({
      sendId: IDLE_HAT_HOLDOUT_SEND_ID,
      type: 'system-announcement',
      message: reminder.message,
      url: reminder.url,
    });
    const held = holdout.recipients!.map((r) => r.userId);
    // Only pushable owners are split; the rest all get the reminder.
    expect(held.every((id) => pushable.includes(id))).toBe(true);
    expect(held.length).toBeGreaterThan(pushable.length * 0.04);
    expect(held.length).toBeLessThan(pushable.length * 0.16);
    expect(reminder.recipients!.map((r) => r.userId).sort((a, b) => a - b)).toEqual(
      ids.filter((id) => !held.includes(id))
    );
    expect(reminder.excludeSendIds).toEqual([
      IDLE_HAT_NUDGE_LEGACY_SEND_ID,
      IDLE_HAT_HOLDOUT_SEND_ID,
    ]);
    expect(holdout.excludeSendIds).toEqual([
      IDLE_HAT_NUDGE_LEGACY_SEND_ID,
      IDLE_HAT_REMINDER_SEND_ID,
    ]);
    expect(result).toMatchObject({
      pushable: pushable.length,
      holdout: { counts: { queued: held.length } },
    });
  });

  it('keeps each owner in the arm a past run put them in', () => {
    // Pinned: a changed salt or hash would reshuffle owners between runs of a live experiment.
    const ids = Array.from({ length: 60 }, (_, i) => i + 1);
    expect(ids.filter(isInHoldout)).toEqual([7, 15, 41, 44, 45, 52, 58]);
  });

  it('asks the event for the team of an owner whose hats name several teams or none', async () => {
    const { run, calls, getUserTeam } = setup(
      [
        { userId: 1, teams: ['Pink', 'Yellow'] },
        { userId: 2, teams: [] },
        { userId: 3, teams: ['Blue'] },
      ],
      { assigned: 'Yellow' }
    );
    const result = await run();

    expect(getUserTeam.mock.calls.map(([id]) => id)).toEqual([1, 2]);
    expect(calls[0].recipients?.map((r) => r.params.team)).toEqual(['Yellow', 'Yellow', 'Blue']);
    expect(result.resolvedByEvent).toBe(2);
  });

  it.each([
    ['before the event', new Date('2026-10-31T23:59:59Z')],
    ['after the event', new Date('2026-12-01T00:00:00Z')],
  ])('refuses to send %s, but still dry-runs', async (_label, now) => {
    const { run, sendSystemNotices } = setup([{ userId: 1, teams: ['Pink'] }], { now });
    await expect(run({ mode: 'send' })).rejects.toThrow(/not running/);
    expect(sendSystemNotices).not.toHaveBeenCalled();
    await run();
    expect(sendSystemNotices).toHaveBeenCalledTimes(1);
  });

  it('returns no user ids to the operator', async () => {
    const { run } = setup([{ userId: 424242, teams: ['Pink'] }]);
    expect(JSON.stringify(await run())).not.toContain('424242');
  });
});

describe('owner queries', () => {
  const pg = new PGlite();

  beforeAll(async () => {
    dbMock.dbRead.$queryRaw.mockImplementation((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const sql = Prisma.sql(strings, ...(values as never[]));
      return (await pg.query(sql.text, sql.values as unknown[])).rows;
    }) as never);
    await pg.exec(`
      CREATE TABLE "Cosmetic" (id int PRIMARY KEY, type text NOT NULL, data jsonb);
      CREATE TABLE "UserCosmetic" ("userId" int NOT NULL, "cosmeticId" int NOT NULL, "equippedToId" int);
      CREATE TABLE "PushSubscription" (id serial PRIMARY KEY, "userId" int NOT NULL);
      CREATE TABLE "UserPushSetting" ("userId" int NOT NULL, type text NOT NULL);
      INSERT INTO "PushSubscription" ("userId") VALUES (10), (10), (12), (13);
      INSERT INTO "UserPushSetting" VALUES
        (10, 'event-reminder'),   -- subscribed twice, reminders on
        (12, 'new-mention'),      -- subscribed, reminders off
        (14, 'event-reminder');   -- reminders on, no subscription
      INSERT INTO "Cosmetic" VALUES
        (1, 'ContentDecoration', '{"event":"birthday2026","team":"Pink"}'),
        (2, 'ContentDecoration', '{"event":"birthday2026","team":"Blue"}'),
        (3, 'ContentDecoration', '{"event":"birthday2026"}'),
        (4, 'ContentDecoration', '{"event":"holiday2025","team":"Pink"}'),
        (5, 'Badge', '{"event":"birthday2026","team":"Pink"}');
      INSERT INTO "UserCosmetic" VALUES
        (10, 1, NULL),             -- idle, one hat
        (11, 1, NULL), (11, 1, 500), -- one of two hats placed
        (12, 1, NULL), (12, 2, NULL), (12, 3, NULL), -- idle, hats of two teams and a teamless one
        (13, 3, NULL),             -- idle, teamless hat only
        (14, 4, NULL),             -- another event's hat
        (15, 5, NULL),             -- a birthday badge, not a hat
        (16, 1, NULL), (16, 5, 7); -- idle hat; the equipped thing is a badge
    `);
  });

  it('returns owners with no birthday hat placed, with the teams their hats name', async () => {
    const owners = await getIdleHatOwners();
    const byUser = Object.fromEntries(owners.map((o) => [o.userId, [...o.teams].sort()]));
    expect(byUser).toEqual({
      10: ['Pink'],
      12: ['Blue', 'Pink'],
      13: [],
      16: ['Pink'],
    });
  });

  it('getPushableUserIds: users with a subscription and push on for event-reminder, once each', async () => {
    expect(await getPushableUserIds([10, 12, 13, 14, 99])).toEqual([10]);
  });
});
