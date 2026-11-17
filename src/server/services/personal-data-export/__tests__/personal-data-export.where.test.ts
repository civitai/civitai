import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  IMAGE_SAFETY_CONDITION,
  planPostgresExport,
  selectSql,
  transformRow,
} from '../sources/postgres';
import { CH_TABLES, USER_BUZZ_ACCOUNT_TYPES, chWheres } from '../sources/clickhouse';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The WHERE clauses decide whose rows an archive gets, so they run here against Postgres, with rows
 * of the subject and of someone else in every table, rather than being read as text.
 */

const ME = 10;
const OTHER = 20;
const plans = planPostgresExport(ME);
const planFor = (name: string) => plans.find((p) => p.name === name)!;
let db: PGlite;

const ids = async (table: string, where: string) =>
  (
    await db.query<{ id: unknown }>(`SELECT id FROM "${table}" WHERE ${where} ORDER BY id`)
  ).rows.map((r) => r.id);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY);
    INSERT INTO "User" VALUES (${ME}), (${OTHER});

    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int, "blockedFor" text, "needsReview" text,
      minor boolean DEFAULT false, ingestion text DEFAULT 'Scanned');
    CREATE TABLE "CsamReport" (id int, "userId" int, images jsonb);
    INSERT INTO "Image" (id, "userId", "blockedFor", "needsReview", minor, ingestion) VALUES
      (1, ${ME}, NULL, NULL, false, 'Scanned'),
      (2, ${ME}, 'tos', NULL, false, 'Blocked'),
      (3, ${ME}, 'CSAM', NULL, false, 'Blocked'),
      (4, ${ME}, NULL, 'csam', false, 'Scanned'),
      (5, ${ME}, NULL, 'minor', false, 'Scanned'),
      (6, ${ME}, NULL, NULL, true, 'Blocked'),
      (7, ${ME}, NULL, NULL, false, 'Scanned'),
      (8, ${ME}, NULL, NULL, true, 'Scanned'),
      (9, ${OTHER}, NULL, NULL, false, 'Scanned'),
      (10, 30, NULL, NULL, false, 'Scanned');
    INSERT INTO "CsamReport" VALUES (1, NULL, '[{"id": 7}]'), (2, 30, '[]'), (3, NULL, '{"bad": 1}');

    CREATE TABLE "ChatMember" ("chatId" int, "userId" int, status text, "leftAt" timestamp,
      "kickedAt" timestamp, "clearedAt" timestamp);
    CREATE TABLE "ChatMessage" (id int PRIMARY KEY, "chatId" int, "userId" int, "createdAt" timestamp,
      "deletedAt" timestamp);
    INSERT INTO "ChatMember" VALUES
      (1, ${ME}, 'Joined', NULL, NULL, NULL),
      (2, ${ME}, 'Left', '2026-01-10', NULL, NULL),
      (3, ${ME}, 'Kicked', NULL, '2026-01-10', NULL),
      (4, ${ME}, 'Ignored', NULL, NULL, NULL),
      (5, ${ME}, 'Joined', NULL, NULL, '2026-01-10'),
      (6, ${OTHER}, 'Joined', NULL, NULL, NULL);
    INSERT INTO "ChatMessage" VALUES
      (101, 1, ${OTHER}, '2026-01-05', NULL),          -- received: yes
      (102, 1, ${ME}, '2026-01-05', NULL),             -- my own (exported elsewhere): no
      (103, 1, ${OTHER}, '2026-01-05', '2026-01-06'),  -- deleted: no
      (104, 2, ${OTHER}, '2026-01-05', NULL),          -- before I left: yes
      (105, 2, ${OTHER}, '2026-01-15', NULL),          -- after I left: no
      (106, 3, ${OTHER}, '2026-01-15', NULL),          -- after I was kicked: no
      (107, 4, ${OTHER}, '2026-01-05', NULL),          -- ignored chat: no
      (108, 5, ${OTHER}, '2026-01-05', NULL),          -- before I cleared it: no
      (109, 5, ${OTHER}, '2026-01-15', NULL),          -- after I cleared it: yes
      (110, 6, ${OTHER}, '2026-01-05', NULL);          -- a chat I am not in: no

    CREATE TABLE "Report" (id int PRIMARY KEY, "userId" int, status text);
    CREATE TABLE "UserReport" ("reportId" int, "userId" int);
    INSERT INTO "Report" VALUES (1, ${OTHER}, 'Actioned'), (2, ${OTHER}, 'Pending'),
      (3, ${OTHER}, 'Unactioned'), (4, ${OTHER}, 'Actioned');
    INSERT INTO "UserReport" VALUES (1, ${ME}), (2, ${ME}), (3, ${ME}), (4, ${OTHER});

    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int);
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int);
    CREATE TABLE "ModelFile" (id int PRIMARY KEY, "modelVersionId" int);
    INSERT INTO "Model" VALUES (1, ${ME}), (2, ${OTHER});
    INSERT INTO "ModelVersion" VALUES (11, 1), (12, 2);
    INSERT INTO "ModelFile" VALUES (111, 11), (112, 12);

    CREATE TABLE "MembershipGift" (id int PRIMARY KEY, "gifterId" int, "recipientId" int,
      "holderId" int);
    INSERT INTO "MembershipGift" VALUES (1, ${ME}, ${OTHER}, ${OTHER}), (2, ${OTHER}, ${ME}, ${OTHER}),
      (3, ${OTHER}, ${OTHER}, ${ME}), (4, ${OTHER}, ${OTHER}, ${OTHER});
  `);
});

afterAll(() => db?.close());

describe('export WHERE clauses, run', () => {
  it("returns the user's images, without those the safety rules leave out", async () => {
    expect(await ids('Image', planFor('Image').where)).toEqual([1, 2, 8]);
  });

  it('flags the same images as unreleasable (the hold reads this condition)', async () => {
    expect(await ids('Image', `"Image"."userId" = ${ME} AND ${IMAGE_SAFETY_CONDITION}`)).toEqual([
      3, 4, 5, 6, 7,
    ]);
    expect(await ids('Image', `"Image"."userId" = 30 AND ${IMAGE_SAFETY_CONDITION}`)).toEqual([10]);
  });

  it('returns the messages the chat shows the user, and nothing else', async () => {
    expect(await ids('ChatMessage', planFor('ChatMessage.received').where)).toEqual([
      101, 104, 109,
    ]);
  });

  it('returns only decided reports about the user', async () => {
    expect(await ids('Report', planFor('Report.aboutYou').where)).toEqual([1, 3]);
  });

  it("returns only the user's own models' versions and files, and their own account row", async () => {
    expect(await ids('ModelVersion', planFor('ModelVersion').where)).toEqual([11]);
    expect(await ids('ModelFile', planFor('ModelFile').where)).toEqual([111]);
    expect(await ids('User', planFor('User').where)).toEqual([ME]);
  });

  it("names a post's owner as the one who added a collaborator, and anyone else as staff", async () => {
    await db.exec(`
      CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int);
      CREATE TABLE "EntityCollaborator" ("entityType" text, "entityId" int, "userId" int,
        status text, "createdAt" timestamp, "createdBy" int, "lastMessageSentAt" timestamp);
      INSERT INTO "Post" VALUES (1, ${OTHER}), (2, ${OTHER});
      INSERT INTO "EntityCollaborator" ("entityType", "entityId", "userId", "createdBy") VALUES
        ('Post', 1, ${ME}, ${OTHER}),  -- the owner added me
        ('Post', 2, ${ME}, 900),       -- a moderator did
        ('Post', 9, ${ME}, ${OTHER});  -- the post is gone: nobody to check against
    `);
    const plan = planFor('EntityCollaborator');
    const { rows } = await db.query<Record<string, unknown>>(
      `${selectSql(plan)} ORDER BY "entityId"`
    );
    const out = rows.map((r) => transformRow(plan, r, ME).out);
    expect(out.map((r) => [r.entityId, r.createdBy])).toEqual([
      [1, OTHER],
      [2, '[staff]'],
      [9, null],
    ]);
    // The owner looked up is read, never written.
    expect(out.every((r) => !('entityOwnerId' in r))).toBe(true);
  });

  it('reads both sides of the Buzz ledger, a self-transfer once, and never a club', async () => {
    const buzz = CH_TABLES.find((t) => t.table === 'default.buzzTransactions')!;
    const types = USER_BUZZ_ACCOUNT_TYPES.map((t) => `'${t}'`).join(', ');
    // The ClickHouse predicates, with their parameters bound, run as SQL.
    const bind = (w: string) =>
      w.replaceAll('{uid:Int64}', String(ME)).replaceAll('{buzzTypes:Array(String)}', `(${types})`);
    await db.exec(`
      -- Unquoted, as ClickHouse writes them, so they fold to one case here.
      CREATE TABLE buzz (id int, fromAccountId int, fromAccountType text,
        toAccountId int, toAccountType text);
      INSERT INTO buzz VALUES
        (1, ${ME}, 'yellow', ${OTHER}, 'yellow'),   -- sent
        (2, ${OTHER}, 'yellow', ${ME}, 'blue'),     -- received
        (3, ${ME}, 'yellow', ${ME}, 'blue'),        -- between my own accounts
        (4, ${OTHER}, 'yellow', ${OTHER}, 'blue'),  -- not mine
        (5, ${ME}, 'club', ${OTHER}, 'yellow'),     -- a club keyed by my id
        (6, ${OTHER}, 'yellow', ${ME}, 'club');
    `);
    const wheres = chWheres(buzz, 'false');
    expect(wheres.length).toBe(2);
    const read: unknown[] = [];
    for (const w of wheres) read.push(...(await ids('buzz', bind(w))));
    expect(read.sort()).toEqual([1, 2, 3]);
  });

  it('matches a row on any of several subject columns', async () => {
    expect(await ids('MembershipGift', planFor('MembershipGift').where)).toEqual([1, 2, 3]);
  });
});
