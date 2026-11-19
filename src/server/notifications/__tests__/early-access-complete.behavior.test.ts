import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { modelNotifications } from '~/server/notifications/model.notifications';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const FOLLOWER = 2;
// The notifier's previous run (lastSent) was 60 s ago.
const RACED = 10; // gate ended 90 s ago, republished 30 s ago: after that run, which was already past endsAt
const LAGGED = 11; // gate ended 90 s ago, republished 80 s ago but not yet on the replica for that run
const GATED = 12; // published 20 s ago, gate still running
const NOT_REPUBLISHED = 13; // gate ended 90 s ago, republish job has not run yet
const LATE_REPUBLISH = 14; // gate ended 3 days ago, publishedAt moved just now
const SETTLED = 15; // republished 10 min ago: notified by an earlier run
const STALE = 16; // republished 40 min ago: outside the wall-clock floor

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Model" (id int PRIMARY KEY, name text, type text);
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, name text, "modelId" int, "publishedAt" timestamp(3), status text);
    CREATE TABLE "PaidAccess" ("entityType" text, "entityId" int, "endsAt" timestamp(3));
    CREATE TABLE "ModelVersionEngagement" ("userId" int, "modelVersionId" int, type text);
    INSERT INTO "Model" VALUES (1, 'm', 'LORA');
    INSERT INTO "ModelVersion" VALUES
      (${RACED}, 'v', 1, now() - interval '30 seconds', 'Published'),
      (${LAGGED}, 'v', 1, now() - interval '80 seconds', 'Published'),
      (${GATED}, 'v', 1, now() - interval '20 seconds', 'Published'),
      (${NOT_REPUBLISHED}, 'v', 1, now() - interval '100 seconds', 'Published'),
      (${LATE_REPUBLISH}, 'v', 1, now() - interval '20 seconds', 'Published'),
      (${SETTLED}, 'v', 1, now() - interval '10 minutes', 'Published'),
      (${STALE}, 'v', 1, now() - interval '40 minutes', 'Published');
    INSERT INTO "PaidAccess" VALUES
      ('ModelVersion', ${RACED}, now() - interval '90 seconds'),
      ('ModelVersion', ${LAGGED}, now() - interval '90 seconds'),
      ('ModelVersion', ${GATED}, now() + interval '7 days'),
      ('ModelVersion', ${NOT_REPUBLISHED}, now() - interval '90 seconds'),
      ('ModelVersion', ${LATE_REPUBLISH}, now() - interval '3 days'),
      ('ModelVersion', ${SETTLED}, now() - interval '11 minutes'),
      ('ModelVersion', ${STALE}, now() - interval '41 minutes');
    INSERT INTO "ModelVersionEngagement"
      SELECT ${FOLLOWER}, id, 'Notify' FROM "ModelVersion";
  `);
});
afterAll(() => db.close());

async function selectedKeys(lastSentAgoMs: number) {
  const query = await modelNotifications['early-access-complete'].prepareQuery!({
    lastSent: new Date(Date.now() - lastSentAgoMs).toISOString(),
  } as never);
  const { rows } = await db.query<{ key: string; userId: number }>(query as string);
  return rows.map((r) => [r.key, r.userId]).sort();
}

describe('early-access-complete', () => {
  it('notifies a version republished after a run whose lastSent had already passed endsAt', async () => {
    expect(await selectedKeys(60_000)).toEqual([
      [`early-access-complete:${RACED}`, FOLLOWER],
      [`early-access-complete:${LAGGED}`, FOLLOWER],
    ]);
  });

  it('a stale cursor reaches back only to the 30-minute floor', async () => {
    expect(await selectedKeys(24 * 60 * 60_000)).toEqual([
      [`early-access-complete:${RACED}`, FOLLOWER],
      [`early-access-complete:${LAGGED}`, FOLLOWER],
      [`early-access-complete:${SETTLED}`, FOLLOWER],
    ]);
  });
});
