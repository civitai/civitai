import { readFileSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import {
  checkHoldsBeforeApprove,
  clearHold,
  getOpenHoldCountsBySlug,
  placeHold,
  PublishRequestHeldError,
  resolveHoldsAtApprove,
} from '~/server/services/blocks/publish-request-holds.service';
import { MAX_OPEN_HOLDS_PER_APP } from '~/shared/constants/publish-request-holds.constants';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20270106120000_app_publish_request_holds/migration.sql'
);

type Raw = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

const AGENT = 900;
const HUMAN = 901;
const REASON = 'security check still running';
const OVERRIDE = 'checked by hand, the finding is a false alarm';

let db: PGlite;
let raw: Raw;

function asRaw(c: { query: PGlite['query'] }): Raw {
  return {
    $queryRaw: pgliteRaw(c as PGlite).queryRaw,
    $executeRaw: pgliteRaw(c as PGlite).executeRaw,
  } as unknown as Raw;
}

async function tx<T>(f: (t: Raw) => Promise<T>): Promise<T> {
  return db.transaction((t) => f(asRaw(t as unknown as PGlite)));
}

async function addRequest(id: string, slug: string, status = 'pending', kind = 'onsite') {
  const table = kind === 'onsite' ? 'app_block_publish_requests' : 'app_listing_publish_requests';
  await db.query(`INSERT INTO ${table} (id, slug, status) VALUES ($1, $2, $3)`, [id, slug, status]);
}

const place = (publishRequestId: string, kind: 'onsite' | 'listing' = 'onsite') =>
  tx((t) =>
    placeHold(t, {
      publishRequestId,
      kind,
      actorUserId: AGENT,
      reason: REASON,
      label: 'code-check',
    })
  );

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    SET TIME ZONE 'UTC';
    CREATE TABLE "User" (id INT PRIMARY KEY, username TEXT);
    INSERT INTO "User" VALUES (900, 'mod-agent'), (901, 'mod-human');
    CREATE TABLE app_block_publish_requests (id TEXT PRIMARY KEY, slug TEXT, status TEXT);
    CREATE TABLE app_listing_publish_requests (id TEXT PRIMARY KEY, slug TEXT, status TEXT);
    CREATE TABLE "ModActivity" (
      id SERIAL PRIMARY KEY, "userId" INT, activity TEXT, "entityType" TEXT, "entityId" INT,
      "createdAt" TIMESTAMPTZ DEFAULT now()
    );
  `);
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  raw = asRaw(db);
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec(`
    TRUNCATE app_publish_request_holds, app_block_publish_requests,
      app_listing_publish_requests, "ModActivity" RESTART IDENTITY;
  `);
});

describe('placing and clearing', () => {
  it('records who placed it, the label, the reason and when', async () => {
    await addRequest('pubreq_a', 'app-a');
    const hold = await place('pubreq_a');
    expect(hold).toMatchObject({
      slug: 'app-a',
      placedByUserId: AGENT,
      placedByUsername: 'mod-agent',
      placedByLabel: 'code-check',
      reason: REASON,
      clearedAt: null,
    });
    expect(hold.createdAt).toBeInstanceOf(Date);
  });

  it('refuses a hold on an approved request', async () => {
    await addRequest('pubreq_a', 'app-a', 'approved');
    await expect(place('pubreq_a')).rejects.toThrow(/already approved/);
  });

  it(`caps open holds at ${MAX_OPEN_HOLDS_PER_APP} per app`, async () => {
    await addRequest('pubreq_a', 'app-a');
    for (let i = 0; i < MAX_OPEN_HOLDS_PER_APP; i++) await place('pubreq_a');
    await expect(place('pubreq_a')).rejects.toThrow(/open holds/);
  });

  it('every clear needs a reason, the placer included', async () => {
    await addRequest('pubreq_a', 'app-a');
    const hold = await place('pubreq_a');
    await expect(
      clearHold(raw, { holdId: hold.id, actorUserId: AGENT, reason: '' })
    ).rejects.toThrow(/reason/);
    await clearHold(raw, { holdId: hold.id, actorUserId: HUMAN, reason: 'check finished, clean' });
    expect((await getOpenHoldCountsBySlug(raw, ['app-a'])).get('app-a')).toBeUndefined();
    await expect(
      clearHold(raw, { holdId: hold.id, actorUserId: HUMAN, reason: 'check finished, clean' })
    ).rejects.toThrow(/already cleared/);
  });
});

describe('approve', () => {
  it('is refused while a hold is open, naming the hold', async () => {
    await addRequest('pubreq_a', 'app-a');
    await place('pubreq_a');
    const err = await checkHoldsBeforeApprove(raw, { slug: 'app-a' }).catch((e) => e);
    expect(err).toBeInstanceOf(PublishRequestHeldError);
    expect(err.message).toContain('code-check (mod-agent): ' + REASON);
  });

  it('passes with no holds and writes nothing', async () => {
    await addRequest('pubreq_a', 'app-a');
    expect(await checkHoldsBeforeApprove(raw, { slug: 'app-a' })).toEqual([]);
    expect(
      await tx((t) =>
        resolveHoldsAtApprove(t, { slug: 'app-a', actorUserId: HUMAN, seenHoldIds: [] })
      )
    ).toEqual([]);
    expect((await db.query('SELECT 1 FROM "ModActivity"')).rows).toHaveLength(0);
  });

  it('a hold on a withdrawn request still blocks the resubmitted one', async () => {
    await addRequest('pubreq_a', 'app-a');
    await place('pubreq_a');
    await db.query(
      `UPDATE app_block_publish_requests SET status = 'withdrawn' WHERE id = 'pubreq_a'`
    );
    await addRequest('pubreq_b', 'app-a');
    await expect(checkHoldsBeforeApprove(raw, { slug: 'app-a' })).rejects.toThrow(
      PublishRequestHeldError
    );
  });

  it('an override marks the holds overridden and records a ModActivity row for each', async () => {
    await addRequest('pubreq_a', 'app-a');
    const h1 = await place('pubreq_a');
    const h2 = await place('pubreq_a');
    const seen = await checkHoldsBeforeApprove(raw, { slug: 'app-a', overrideReason: OVERRIDE });
    await tx((t) =>
      resolveHoldsAtApprove(t, {
        slug: 'app-a',
        actorUserId: HUMAN,
        overrideReason: OVERRIDE,
        seenHoldIds: seen,
      })
    );
    const { rows: holds } = await db.query<{
      cleared_kind: string;
      cleared_reason: string;
      cleared_by_user_id: number;
    }>(
      'SELECT cleared_kind, cleared_reason, cleared_by_user_id FROM app_publish_request_holds ORDER BY id'
    );
    expect(holds).toEqual([
      { cleared_kind: 'overridden', cleared_reason: OVERRIDE, cleared_by_user_id: HUMAN },
      { cleared_kind: 'overridden', cleared_reason: OVERRIDE, cleared_by_user_id: HUMAN },
    ]);
    const { rows: acts } = await db.query(
      'SELECT "userId", activity, "entityType", "entityId" FROM "ModActivity" ORDER BY "entityId"'
    );
    expect(acts).toEqual([
      {
        userId: HUMAN,
        activity: 'publishRequestHoldOverride',
        entityType: 'publishRequestHold',
        entityId: h1.id,
      },
      {
        userId: HUMAN,
        activity: 'publishRequestHoldOverride',
        entityType: 'publishRequestHold',
        entityId: h2.id,
      },
    ]);
  });

  it('refuses at the final check a hold placed after the first check, even with an override', async () => {
    await addRequest('pubreq_a', 'app-a');
    await place('pubreq_a');
    const seen = await checkHoldsBeforeApprove(raw, { slug: 'app-a', overrideReason: OVERRIDE });
    await place('pubreq_a');
    await expect(
      tx((t) =>
        resolveHoldsAtApprove(t, {
          slug: 'app-a',
          actorUserId: HUMAN,
          overrideReason: OVERRIDE,
          seenHoldIds: seen,
        })
      )
    ).rejects.toThrow(/placed while this approve was running/);
    expect((await getOpenHoldCountsBySlug(raw, ['app-a'])).get('app-a')).toBe(2);
    expect((await db.query('SELECT 1 FROM "ModActivity"')).rows).toHaveLength(0);
  });

  it('refuses a short override reason', async () => {
    await addRequest('pubreq_a', 'app-a');
    await place('pubreq_a');
    await expect(
      checkHoldsBeforeApprove(raw, { slug: 'app-a', overrideReason: 'ok.' })
    ).rejects.toThrow(/override reason/);
  });

  it('holds on a listing request block by the same app slug', async () => {
    await addRequest('alpr_a', 'app-a', 'pending', 'listing');
    await place('alpr_a', 'listing');
    await expect(checkHoldsBeforeApprove(raw, { slug: 'app-a' })).rejects.toThrow(
      PublishRequestHeldError
    );
  });
});

describe('with the table absent', () => {
  it('approve fails closed and the queue count fails open', async () => {
    const bare = new PGlite();
    try {
      const r = asRaw(bare);
      await expect(checkHoldsBeforeApprove(r, { slug: 'app-a' })).rejects.toThrow(
        /approve is refused/
      );
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect((await getOpenHoldCountsBySlug(r, ['app-a'])).size).toBe(0);
    } finally {
      await bare.close();
    }
  });
});
