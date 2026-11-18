import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import type { NextApiRequest, NextApiResponse } from 'next';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnseenNotifications, UnseenNotificationsInput } from '@civitai/notifications';
import { pgliteKysely } from '~/__tests__/pglite-kysely';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { sendEmail } from '~/server/email/client';
import type * as DbHelpers from '~/server/db/db-helpers';
import type * as NotificationsClient from '~/server/notifications/client';
import type * as DetailFetchers from '~/server/notifications/detail-fetchers';
import type * as SilenceAges from '~/server/notifications/silence-check-ages';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type * as FliptClient from '~/server/flipt/client';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const h = vi.hoisted(() => ({
  pg: null as unknown as PGlite,
  kv: new Map<string, unknown>(),
  unseen: vi.fn(),
  isFlipt: vi.fn(),
}));

vi.mock('~/server/email/client', () => ({ sendEmail: vi.fn(), isEmailConfigured: () => true }));
vi.mock('~/server/db/db-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbHelpers>()),
  dbKV: {
    get: async (key: string, defaultValue?: unknown) =>
      h.kv.has(key) ? h.kv.get(key) : defaultValue,
    set: async (key: string, value: unknown) => {
      h.kv.set(key, JSON.parse(JSON.stringify(value)));
    },
  },
}));
vi.mock('~/server/notifications/client', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsClient>()),
  notifications: { queryUnseenNotifications: h.unseen },
}));
// The digest renders from each row's own `details`, so the main-DB enrichment has nothing to add.
vi.mock('~/server/notifications/detail-fetchers', async (importOriginal) => ({
  ...(await importOriginal<typeof DetailFetchers>()),
  populateNotificationDetails: async () => undefined,
}));
vi.mock('~/server/notifications/silence-check-ages', async (importOriginal) => ({
  ...(await importOriginal<typeof SilenceAges>()),
  silenceCheckTypeAges: async () => [
    { type: 'new-comment', firstSeen: '2026-01-01T00:00:00.000Z' },
    { type: 'new-mention', firstSeen: '2026-01-01T00:00:00.000Z' },
  ],
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: h.isFlipt,
}));
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  PublicEndpoint: (handler: unknown) => handler,
}));

const { DIGEST_CURSOR_KEY, DIGEST_ITEM_LIMIT, runMissedNotificationDigest } = await import(
  '~/server/services/notification-digest.service'
);
const { getEmailUnsubscribeUrl } = await import('~/server/services/notification-email.service');
const { MISSED_DIGEST_EMAIL_TYPE } = await import('~/server/notifications/missed-digest.constants');
const unsubscribe = (await import('~/pages/api/notifications/email-unsubscribe'))
  .default as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations'
);
const migration = (dir: string) =>
  readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8');

const NOW = new Date('2026-11-16T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const db = pgliteKysely(() => h.pg);

// [id, email, verified, deleted, moderator]
const USERS: Array<[number, string | null, boolean, boolean, boolean]> = [
  [1, 'one@example.com', true, false, false], // unseen notifications: emailed
  [2, 'two@example.com', true, false, false], // nothing unseen
  [3, 'three@example.com', true, false, false], // opted out of the digest
  [4, 'four@example.com', false, false, false], // address never verified
  [5, 'five@example.com', true, false, false], // turned every notification off
  [6, 'six@example.com', true, false, false], // sent a digest two days ago
  [7, 'seven@example.com', true, true, false], // deleted
  [8, null, false, false, false], // no address
  [9, 'nine@example.com', true, false, true], // sent one six and a half days ago; a moderator
];
// Users 1 and 2 entered the rollout a pass ago (their start floor, eight days back) and have not
// been sent one since; the "start floor" cases below delete these rows to start from a fresh enable.
const STARTED_AT = '2026-11-08 12:00:00';

const item = (id: number, message: string) => ({
  id,
  type: 'system-message',
  category: 'Other' as const,
  details: { message, url: `/images/${id}` },
  createdAt: daysAgo(1),
});

/** What the notifications app answers: users 1, 6 and 9 have unseen notifications. */
function unseenFor(input: UnseenNotificationsInput): UnseenNotifications[] {
  const all: UnseenNotifications[] = [
    {
      userId: 1,
      total: 14,
      floor: false,
      items: Array.from({ length: DIGEST_ITEM_LIMIT }, (_, i) => item(100 + i, `Reply #${i}`)),
    },
    { userId: 6, total: 1, floor: false, items: [item(200, 'Six')] },
    { userId: 9, total: 1, floor: false, items: [item(300, 'Nine')] },
  ];
  const asked = new Set(input.users.map((u) => u.userId));
  return all.filter((u) => asked.has(u.userId));
}

beforeAll(async () => {
  h.pg = new PGlite();
  await h.pg.exec(`
    CREATE TABLE "User" ("id" integer PRIMARY KEY, "email" text, "emailVerified" timestamp(3),
      "deletedAt" timestamp(3), "bannedAt" timestamp(3), "isModerator" boolean DEFAULT false);
    CREATE TABLE "UserNotificationSettings" ("id" serial PRIMARY KEY, "userId" integer NOT NULL,
      "type" text NOT NULL, "disabledAt" timestamp(3) NOT NULL DEFAULT now());
  `);
  await h.pg.exec(migration('20261203120000_user_email_notification_opt_out'));
  const raw = pgliteRaw(h.pg);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
});

afterAll(async () => {
  await h.pg.close();
});

async function seed({ withDigestTable = true } = {}) {
  await h.pg.exec(`
    DROP TABLE IF EXISTS "UserNotificationDigest";
    TRUNCATE "UserEmailNotificationOptOut", "UserNotificationSettings";
    DELETE FROM "User";
  `);
  if (withDigestTable) await h.pg.exec(migration('20271117150000_user_notification_digest'));
  for (const [id, email, verified, deleted, moderator] of USERS)
    await h.pg.query(
      `INSERT INTO "User" (id, email, "emailVerified", "deletedAt", "isModerator") VALUES ($1, $2, $3, $4, $5)`,
      [id, email, verified ? '2026-01-01' : null, deleted ? '2026-06-01' : null, moderator]
    );
  await h.pg.query(`INSERT INTO "UserEmailNotificationOptOut" ("userId", type) VALUES (3, $1)`, [
    MISSED_DIGEST_EMAIL_TYPE,
  ]);
  await h.pg.exec(`
    INSERT INTO "UserNotificationSettings" ("userId", type, "disabledAt") VALUES
      (5, 'new-comment', '2026-06-01'), (5, 'new-mention', '2026-06-01'),
      (2, 'new-comment', '2026-06-01');
  `);
  if (withDigestTable)
    await h.pg.query(
      `INSERT INTO "UserNotificationDigest" ("userId", "lastSentAt") VALUES (6, $1), (9, $2), (1, $3), (2, $3)`,
      [
        daysAgo(2).toISOString().replace('Z', ''),
        daysAgo(6.5).toISOString().replace('Z', ''),
        STARTED_AT,
      ]
    );
}

let clock = NOW;
const run = (deps: Parameters<typeof runMissedNotificationDigest>[0] = {}) =>
  runMissedNotificationDigest({
    now: () => clock,
    sleep: async () => undefined,
    read: db,
    write: db,
    batchSize: 4,
    inRollout: async () => true,
    emailEnabled: async () => true,
    ...deps,
  });

/** The user's `UserNotificationDigest.lastSentAt` as UTC wall time, or null without a row. */
async function lastSentAt(userId: number): Promise<string | null> {
  const { rows } = await h.pg.query<{ at: string }>(
    `SELECT to_char("lastSentAt", 'YYYY-MM-DD HH24:MI:SS') AS at FROM "UserNotificationDigest" WHERE "userId" = $1`,
    [userId]
  );
  return rows[0]?.at ?? null;
}

const mailedTo = () =>
  vi
    .mocked(sendEmail)
    .mock.calls.map(([mail]) => mail.to)
    .sort();

beforeEach(async () => {
  clock = NOW;
  h.kv.clear();
  vi.mocked(sendEmail).mockReset();
  h.unseen.mockReset();
  h.unseen.mockImplementation(async (input: UnseenNotificationsInput) => unseenFor(input));
  h.isFlipt.mockReset();
  h.isFlipt.mockResolvedValue(false);
  await seed();
});

// `inRollout` runs after the page is read and before any send, so it stands in for a write
// made by someone else in between.
const between =
  (sqlText: string, params: unknown[] = []) =>
  async (id: number) => {
    if (id === 1) await h.pg.query(sqlText, params);
    return true;
  };

describe('who gets the weekly digest', () => {
  it('emails only users with unseen notifications, and counts every skip by its reason', async () => {
    const result = await run();
    expect(mailedTo()).toEqual(['nine@example.com', 'one@example.com']);
    expect(result).toMatchObject({
      idle: null,
      considered: 8,
      emailed: 2,
      failed: 0,
      cycleDone: true,
      skipped: {
        'no-verified-email': 2,
        'opted-out': 1,
        'not-in-rollout': 0,
        'all-notifications-off': 1,
        'first-pass': 0,
        'recently-sent': 1,
        'none-unseen': 1,
        unrenderable: 0,
      },
    });
  });

  it('asks only about eligible users, leaves out the types already emailed, and never re-lists a sent item', async () => {
    await run();
    const asked = h.unseen.mock.calls.flatMap(
      ([input]) => (input as UnseenNotificationsInput).users
    );
    expect(asked.map((u) => u.userId).sort()).toEqual([1, 2, 9]);
    // A user never sent one starts a week back; a user sent one since starts where it left off.
    expect(asked.find((u) => u.userId === 1)!.since).toEqual(daysAgo(7));
    expect(asked.find((u) => u.userId === 9)!.since).toEqual(daysAgo(6.5));
    const excluded = (h.unseen.mock.calls[0]![0] as UnseenNotificationsInput).excludeTypes;
    expect(excluded).toContain('service-deal-requested');
    expect(excluded).not.toContain('system-message');
  });

  it('skips users outside the flag rollout before asking about them', async () => {
    const result = await run({ inRollout: async (id) => id !== 1 });
    expect(mailedTo()).toEqual(['nine@example.com']);
    expect(result.skipped['not-in-rollout']).toBe(1);
    const asked = h.unseen.mock.calls.flatMap(
      ([input]) => (input as UnseenNotificationsInput).users
    );
    expect(asked.map((u) => u.userId)).not.toContain(1);
  });

  it('sends one per user per week: a second run that week does nothing, even from a lost cursor', async () => {
    await run();
    vi.mocked(sendEmail).mockReset();

    clock = new Date(NOW.getTime() + 3 * 60 * 60 * 1000);
    expect((await run()).idle).toBe('cycle-done');

    h.kv.delete(DIGEST_CURSOR_KEY);
    const rerun = await run();
    expect(rerun.emailed).toBe(0);
    expect(rerun.skipped['recently-sent']).toBe(3);
    expect(sendEmail).not.toHaveBeenCalled();

    // The next pass starts a week after the last one did (that was the lost-cursor rerun's).
    clock = new Date(NOW.getTime() + 8 * DAY);
    await run();
    expect(mailedTo()).toEqual(['nine@example.com', 'one@example.com', 'six@example.com']);
  });

  it('sends nothing while the digest table is missing', async () => {
    await seed({ withDigestTable: false });
    const result = await run();
    expect(result.idle).toBe('table-missing');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('stops at the per-run send cap and the next run carries on from there', async () => {
    const first = await run({ maxSends: 1 });
    expect(first).toMatchObject({ emailed: 1, stopped: 'send-cap', cycleDone: false });
    expect(mailedTo()).toEqual(['one@example.com']);

    const second = await run({ maxSends: 1 });
    expect(second.emailed).toBe(1);
    expect(mailedTo()).toEqual(['nine@example.com', 'one@example.com']);
  });

  it('stops for the run budget before reading a page, not only before a send', async () => {
    const result = await run({ budgetMs: 0 });
    expect(result).toMatchObject({
      considered: 0,
      emailed: 0,
      stopped: 'budget',
      cycleDone: false,
    });
    expect(h.unseen).not.toHaveBeenCalled();
  });

  it('an opt-out written after the page was read still holds: it is re-read before the send', async () => {
    // The page is read first, then each user's rollout is checked: user 1 opts out in between.
    const result = await run({
      inRollout: async (id) => {
        if (id === 1)
          await h.pg.query(
            `INSERT INTO "UserEmailNotificationOptOut" ("userId", type) VALUES (1, $1)`,
            [MISSED_DIGEST_EMAIL_TYPE]
          );
        return true;
      },
    });
    expect(mailedTo()).toEqual(['nine@example.com']);
    expect(result.skipped['opted-out']).toBe(2);
    expect(await lastSentAt(1)).toBe(STARTED_AT);
  });

  it('an address changed after the page was read: the digest goes to the new address', async () => {
    await run({ inRollout: between(`UPDATE "User" SET email = 'new@example.com' WHERE id = 1`) });
    expect(mailedTo()).toEqual(['new@example.com', 'nine@example.com']);
  });

  it('a user banned after the page was read is not emailed', async () => {
    const result = await run({
      inRollout: between(`UPDATE "User" SET "bannedAt" = '2026-11-16' WHERE id = 1`),
    });
    expect(mailedTo()).toEqual(['nine@example.com']);
    expect(result.skipped['no-verified-email']).toBe(3);
  });

  it('a digest another run recorded after the page was read stops this run sending a second', async () => {
    const result = await run({
      inRollout: between(
        `UPDATE "UserNotificationDigest" SET "lastSentAt" = $1 WHERE "userId" = 1`,
        [NOW.toISOString().replace('Z', '')]
      ),
    });
    expect(mailedTo()).toEqual(['nine@example.com']);
    expect(result.skipped['recently-sent']).toBe(2);
  });

  it('records the send as of when the unseen list was read, so nothing created during the send is lost', async () => {
    // The notifications app answers five minutes after the page's read time.
    h.unseen.mockImplementation(async (input: UnseenNotificationsInput) => {
      clock = new Date(clock.getTime() + 5 * 60 * 1000);
      return unseenFor(input);
    });
    const pageReadAt = NOW.toISOString().replace('Z', '');
    await run();
    const rows = await h.pg.query<{ ok: boolean }>(
      `SELECT "lastSentAt" = $1::timestamp AS ok FROM "UserNotificationDigest" WHERE "userId" = 1`,
      [pageReadAt]
    );
    expect(rows.rows).toEqual([{ ok: true }]);
  });

  it('a failed send is not recorded, so the user is tried again on the next pass', async () => {
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error('boom'));
    const result = await run();
    expect(result.failed).toBe(1);
    // User 1 failed (first in id order): its row is back at its start floor, so the next pass
    // tries it again; 9 was sent.
    expect(await lastSentAt(1)).toBe(STARTED_AT);
    expect(await lastSentAt(9)).toBe('2026-11-16 12:00:00');
  });
});

const askedUsers = () =>
  h.unseen.mock.calls.flatMap(([input]) => (input as UnseenNotificationsInput).users);

describe('the start floor: no digest lists a notification from before the user was enabled', () => {
  // Users 1 and 2 have never been in the rollout: no UserNotificationDigest row, as on a fresh
  // enable. User 1 has a backlog of 14 unseen notifications.
  beforeEach(async () => {
    await h.pg.exec(`DELETE FROM "UserNotificationDigest" WHERE "userId" IN (1, 2)`);
  });

  it('the first run after enable sends nothing for the backlog: it records the floor instead', async () => {
    const result = await run();
    expect(mailedTo()).toEqual(['nine@example.com']);
    expect(result.skipped['first-pass']).toBe(2);
    // Never asked about: the backlog is not even read.
    expect(askedUsers().map((u) => u.userId)).toEqual([9]);
    expect(await lastSentAt(1)).toBe('2026-11-16 12:00:00');
    expect(await lastSentAt(2)).toBe('2026-11-16 12:00:00');
  });

  it("the next digest's window starts at the floor, even when the week-back window starts earlier", async () => {
    await run();
    // A pass started early (its cursor deleted) six and a half days later: the week-back window
    // would start 2026-11-16T00:00Z, before the floor.
    h.kv.delete(DIGEST_CURSOR_KEY);
    h.unseen.mockClear();
    clock = new Date('2026-11-23T00:00:00.000Z');
    await run();
    const asked = askedUsers();
    expect(asked.find((u) => u.userId === 1)!.since).toEqual(new Date('2026-11-16T12:00:00.000Z'));
    expect(mailedTo()).toContain('one@example.com');
  });

  it('each user gets their own floor when the rollout reaches them: a later stage does not inherit the backlog', async () => {
    await h.pg.exec(`DELETE FROM "UserNotificationDigest"`);
    // Stage 1: user 1 only.
    await run({ inRollout: async (id) => id === 1 });
    expect(mailedTo()).toEqual([]);
    expect(await lastSentAt(1)).toBe('2026-11-16 12:00:00');
    expect(await lastSentAt(9)).toBeNull();

    // Stage 2, the next pass a week later: user 9 joins with a backlog of its own.
    clock = new Date('2026-11-23T12:00:00.000Z');
    h.unseen.mockClear();
    await run({ inRollout: async (id) => id === 1 || id === 9 });
    expect(mailedTo()).toEqual(['one@example.com']);
    expect(askedUsers()).toEqual([{ userId: 1, since: new Date('2026-11-16T12:00:00.000Z') }]);
    expect(await lastSentAt(9)).toBe('2026-11-23 12:00:00');

    // Stage 2's next pass: user 9's first digest starts at its own floor, not at user 1's.
    vi.mocked(sendEmail).mockReset();
    h.unseen.mockClear();
    clock = new Date('2026-11-30T12:00:00.000Z');
    await run({ inRollout: async (id) => id === 1 || id === 9 });
    expect(mailedTo()).toEqual(['nine@example.com', 'one@example.com']);
    expect(askedUsers().find((u) => u.userId === 9)!.since).toEqual(
      new Date('2026-11-23T12:00:00.000Z')
    );
  });

  it('a user outside the rollout gets no floor, so their floor is when they join, not when the job first saw them', async () => {
    await run({ inRollout: async () => false });
    expect(await lastSentAt(1)).toBeNull();
  });

  it('a floor row another run wrote first is kept, and that user is not sent to this pass', async () => {
    const result = await run({
      inRollout: between(
        `INSERT INTO "UserNotificationDigest" ("userId", "lastSentAt") VALUES (1, '2026-11-16 11:00:00')`
      ),
    });
    expect(mailedTo()).toEqual(['nine@example.com']);
    expect(await lastSentAt(1)).toBe('2026-11-16 11:00:00');
    expect(result.skipped['first-pass']).toBe(1);
  });
});

describe('with the flag off for everyone', () => {
  it('a whole pass emails nobody, writes no rows, reads no notifications and finishes', async () => {
    await h.pg.exec(`DELETE FROM "UserNotificationDigest"`);
    const result = await run({ inRollout: async () => false });
    expect(result).toMatchObject({ emailed: 0, failed: 0, cycleDone: true, stopped: null });
    expect(result.skipped['not-in-rollout']).toBe(5);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(h.unseen).not.toHaveBeenCalled();
    const { rows } = await h.pg.query(`SELECT 1 FROM "UserNotificationDigest"`);
    expect(rows).toHaveLength(0);
  });
});

describe('the Flipt evaluation', () => {
  it("passes the user's id and moderator bit as context, so a userId or moderators segment can match", async () => {
    // A segment on the context: moderators only, as the moderators segment matches.
    h.isFlipt.mockImplementation(
      async (_flag: string, _entityId?: string, context?: Record<string, string>) =>
        context?.isModerator === 'true'
    );
    await run({ inRollout: undefined });
    expect(mailedTo()).toEqual(['nine@example.com']);
    expect(h.isFlipt).toHaveBeenCalledWith('missed-notification-digest', '9', {
      userId: '9',
      isModerator: 'true',
    });
    expect(h.isFlipt).toHaveBeenCalledWith('missed-notification-digest', '1', {
      userId: '1',
      isModerator: 'false',
    });
  });
});

describe('the type ages the silence check reads', () => {
  it('are the earliest disabledAt per asked type, from the real grouped read', async () => {
    // The suite mocks this module; this case runs the real query against the seeded rows.
    const { silenceCheckTypeAges } = await vi.importActual<typeof SilenceAges>(
      '~/server/notifications/silence-check-ages'
    );
    dbMock.dbRead.$queryRaw.mockImplementation(pgliteRaw(h.pg).queryRaw as never);
    // Earlier than the seeded 2026-06-01 rows, so a max() or a first-row read gives other values.
    await h.pg.exec(`
      INSERT INTO "UserNotificationSettings" ("userId", type, "disabledAt") VALUES
        (9, 'new-comment', '2026-03-04 05:06:07'),
        (6, 'new-mention', '2026-04-05 06:07:08'),
        (6, 'new-like', '2026-01-01 00:00:00');
    `);
    const ages = await silenceCheckTypeAges(['new-comment', 'new-mention', 'new-follow']);
    // 'new-like' was not asked for; 'new-follow' was, but nobody has switched it off.
    expect([...ages].sort((a, b) => a.type.localeCompare(b.type))).toEqual([
      { type: 'new-comment', firstSeen: '2026-03-04T05:06:07.000Z' },
      { type: 'new-mention', firstSeen: '2026-04-05T06:07:08.000Z' },
    ]);
  });
});

describe('the notification-email kill switch', () => {
  it('with the switch off a run sends nothing and leaves the pass where it was', async () => {
    const result = await run({ emailEnabled: async () => false });
    expect(result).toMatchObject({ idle: 'email-disabled', considered: 0, emailed: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(h.unseen).not.toHaveBeenCalled();
    expect(h.kv.has(DIGEST_CURSOR_KEY)).toBe(false);
  });

  it('turned off mid-run, the run stops at its next send; turned back on, the next run carries on', async () => {
    let enabled = true;
    vi.mocked(sendEmail).mockImplementation(async () => {
      enabled = false;
      return undefined as never;
    });
    const first = await run({ emailEnabled: async () => enabled });
    expect(first).toMatchObject({ emailed: 1, stopped: 'email-disabled', cycleDone: false });
    expect(mailedTo()).toEqual(['one@example.com']);

    enabled = true;
    vi.mocked(sendEmail).mockReset();
    const second = await run({ emailEnabled: async () => enabled });
    expect(second.emailed).toBe(1);
    expect(mailedTo()).toEqual(['nine@example.com']);
  });

  it('by default it reads the notification-email-enabled KeyValue row', async () => {
    const { clearNotificationEmailEnabledCache } = await import(
      '~/server/services/notification-email.service'
    );
    clearNotificationEmailEnabledCache();
    dbMock.dbRead.keyValue.findUnique.mockResolvedValue({
      key: 'notification-email-enabled',
      value: false,
    } as never);
    const off = await run({ emailEnabled: undefined });
    expect(off.idle).toBe('email-disabled');
    expect(sendEmail).not.toHaveBeenCalled();

    clearNotificationEmailEnabledCache();
    dbMock.dbRead.keyValue.findUnique.mockResolvedValue({
      key: 'notification-email-enabled',
      value: true,
    } as never);
    const on = await run({ emailEnabled: undefined });
    expect(on.emailed).toBe(2);
    clearNotificationEmailEnabledCache();
  });
});

describe('the digest email', () => {
  it('lists the newest ten with "and N more", and links each item and the notifications page', async () => {
    await run();
    const mail = vi
      .mocked(sendEmail)
      .mock.calls.map(([m]) => m)
      .find((m) => m.to === 'one@example.com')!;
    expect(mail.subject).toBe("You have 14 notifications you haven't seen");
    expect(mail.text).toContain('- Reply #0\n  http://localhost:3000/images/100');
    expect(mail.text).toContain('- Reply #9');
    expect(mail.text).toContain('and 4 more');
    expect(mail.text).toContain('See all notifications: http://localhost:3000/user/notifications');
    expect(mail.html).toContain('href="http://localhost:3000/images/109"');
    expect(mail.html).toContain('href="http://localhost:3000/user/notifications"');
    expect(mail.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(mail.headers?.['List-Unsubscribe']).toContain(`t=${MISSED_DIGEST_EMAIL_TYPE}`);
  });

  it('a one-click unsubscribe turns the digest off for that user', async () => {
    const query = Object.fromEntries(
      new URL(getEmailUnsubscribeUrl(1, MISSED_DIGEST_EMAIL_TYPE)).searchParams
    );
    let status = 0;
    const res = {
      status(code: number) {
        status = code;
        return res;
      },
      setHeader: () => res,
      send: () => res,
    } as unknown as NextApiResponse;
    await unsubscribe(
      { method: 'POST', query, body: {}, headers: {} } as unknown as NextApiRequest,
      res
    );
    expect(status).toBe(200);

    const result = await run();
    expect(mailedTo()).toEqual(['nine@example.com']);
    expect(result.skipped['opted-out']).toBe(2);
  });
});
