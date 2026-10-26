import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { sendEmail } from '~/server/email/client';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import {
  clearNotificationEmailEnabledCache,
  optOutOfNotificationEmail,
  sendNotificationEmails,
} from '~/server/services/notification-email.service';

vi.mock('~/server/email/client', () => ({ sendEmail: vi.fn(), isEmailConfigured: () => true }));
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Who gets mailed lives in SQL (the opt-out NOT EXISTS, deleted and banned users), which a mocked
 * client cannot see. Run as written against an in-process Postgres carrying the real migrations.
 */
const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations'
);
const migration = (dir: string) =>
  readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
const db = { pg: null as unknown as PGlite };

const DEAL = 'service-deal-requested';
const deal = { type: DEAL, details: { dealId: 7, offeringTitle: 'Portrait' } };

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TABLE "User" ("id" integer PRIMARY KEY, "email" text, "deletedAt" timestamp(3), "bannedAt" timestamp(3));
    CREATE TABLE "PushSubscription" ("id" serial PRIMARY KEY, "userId" integer NOT NULL);
    CREATE TABLE "UserPushSetting" ("userId" integer NOT NULL, "type" text NOT NULL, PRIMARY KEY ("userId", "type"));
  `);
  await db.pg.exec(migration('20261203120000_user_email_notification_opt_out'));

  const raw = pgliteRaw(db.pg);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
});

afterAll(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  vi.mocked(sendEmail).mockReset();
  clearNotificationEmailEnabledCache();
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue({ key: 'k', value: true } as never);
  redisMock.sysRedis.incrBy.mockResolvedValue(1 as never);
  await db.pg.exec(`
    TRUNCATE "UserEmailNotificationOptOut", "PushSubscription", "UserPushSetting";
    DELETE FROM "User";
    INSERT INTO "User" VALUES
      (1, 'one@example.com', NULL, NULL),
      (2, 'two@example.com', NULL, NULL),
      (3, NULL, NULL, NULL),
      (4, 'deleted@example.com', now(), NULL),
      (5, 'banned@example.com', NULL, now());
  `);
});

const mailedTo = () =>
  vi
    .mocked(sendEmail)
    .mock.calls.map(([mail]) => mail.to)
    .sort();

describe('notification email recipients', () => {
  it('mails users with an address who are not deleted or banned', async () => {
    await sendNotificationEmails({ ...deal, userIds: [1, 2, 3, 4, 5] });
    expect(mailedTo()).toEqual(['one@example.com', 'two@example.com']);
  });

  it('an unsubscribe stops that type and only that type', async () => {
    await optOutOfNotificationEmail(1, DEAL);
    await sendNotificationEmails({ ...deal, userIds: [1, 2] });
    expect(mailedTo()).toEqual(['two@example.com']);

    vi.mocked(sendEmail).mockReset();
    await sendNotificationEmails({
      type: 'service-deal-paid-out',
      details: deal.details,
      userIds: [1],
    });
    expect(mailedTo()).toEqual(['one@example.com']);
  });

  it('an unsubscribe for a user who no longer exists writes nothing and does not throw', async () => {
    await optOutOfNotificationEmail(999, DEAL);
    const rows = await db.pg.query(`SELECT 1 FROM "UserEmailNotificationOptOut"`);
    expect(rows.rows).toHaveLength(0);
  });
});

describe('deal push backfill', () => {
  const backfill = () => db.pg.exec(migration('20261203120100_deal_push_default_backfill'));
  const pushTypes = async (userId: number) =>
    (
      await db.pg.query<{ type: string }>(
        `SELECT "type" FROM "UserPushSetting" WHERE "userId" = $1 ORDER BY "type"`,
        [userId]
      )
    ).rows.map((r) => r.type);

  it('gives existing subscribers every deal type, and leaves anyone who chose about deals alone', async () => {
    await db.pg.exec(`
      INSERT INTO "PushSubscription" ("userId") VALUES (1), (1), (2);
      INSERT INTO "UserPushSetting" VALUES (1, 'new-mention'), (2, 'service-deal-accepted');
    `);
    await backfill();
    await backfill();

    const one = await pushTypes(1);
    expect(one).toContain('new-mention');
    expect(one.filter((t) => t.startsWith('service-deal-'))).toHaveLength(9);
    expect(await pushTypes(2)).toEqual(['service-deal-accepted']);
    expect(await pushTypes(3)).toEqual([]);
  });
});
