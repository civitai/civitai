import { readFileSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import {
  checkHoldsBeforeApprove,
  claimApprove,
  clearHold,
  getOpenHoldCountsBySlug,
  placeHold,
  PublishRequestHeldError,
  releaseApproveClaim,
  resolveHoldsAtApprove,
} from '~/server/services/blocks/publish-request-holds.service';
import { MAX_OPEN_HOLDS_PER_APP } from '~/shared/constants/publish-request-holds.constants';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20270114120000_app_publish_request_holds/migration.sql'
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
    TRUNCATE app_publish_request_holds, app_publish_request_approve_claims, app_block_publish_requests,
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
    await expect(checkHoldsBeforeApprove(raw, { slug: 'app-a' })).resolves.toBeUndefined();
    expect(
      await tx((t) => resolveHoldsAtApprove(t, { slug: 'app-a', actorUserId: HUMAN }))
    ).toEqual({ overridden: [], late: [] });
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
    const decision = { slug: 'app-a', overrideReason: OVERRIDE, shownHoldIds: [h1.id, h2.id] };
    await checkHoldsBeforeApprove(raw, decision);
    await tx((t) => resolveHoldsAtApprove(t, { ...decision, actorUserId: HUMAN }));
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
    // The audit trail end to end: from each ModActivity row to its hold's reason and request.
    const { rows: trail } = await db.query(
      `SELECT h.cleared_kind, h.cleared_reason, h.publish_request_id, h.slug
       FROM "ModActivity" m JOIN app_publish_request_holds h ON h.id = m."entityId"
       WHERE m."entityType" = 'publishRequestHold' AND m.activity = 'publishRequestHoldOverride'
       ORDER BY h.id`
    );
    expect(trail).toEqual([
      {
        cleared_kind: 'overridden',
        cleared_reason: OVERRIDE,
        publish_request_id: 'pubreq_a',
        slug: 'app-a',
      },
      {
        cleared_kind: 'overridden',
        cleared_reason: OVERRIDE,
        publish_request_id: 'pubreq_a',
        slug: 'app-a',
      },
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

  it('🔴 an override passes only the holds the moderator was shown; one placed after refuses', async () => {
    await addRequest('pubreq_a', 'app-a');
    const shown = await place('pubreq_a');
    await place('pubreq_a');
    const decision = { slug: 'app-a', overrideReason: OVERRIDE, shownHoldIds: [shown.id] };
    await expect(checkHoldsBeforeApprove(raw, decision)).rejects.toThrow(
      /placed after this review was loaded/
    );
    await expect(
      tx((t) => resolveHoldsAtApprove(t, { ...decision, actorUserId: HUMAN }))
    ).rejects.toThrow(/placed after this review was loaded/);
    expect((await getOpenHoldCountsBySlug(raw, ['app-a'])).get('app-a')).toBe(2);
    expect((await db.query('SELECT 1 FROM "ModActivity"')).rows).toHaveLength(0);
  });

  it('refuses a short override reason', async () => {
    await addRequest('pubreq_a', 'app-a');
    const h = await place('pubreq_a');
    await expect(
      checkHoldsBeforeApprove(raw, { slug: 'app-a', overrideReason: 'ok.', shownHoldIds: [h.id] })
    ).rejects.toThrow(/override reason/);
  });

  it('🔴 a hold on one app never blocks another, and an override leaves the other app’s hold open', async () => {
    await addRequest('pubreq_a', 'app-a');
    await addRequest('pubreq_b', 'app-b');
    await place('pubreq_a');
    await expect(checkHoldsBeforeApprove(raw, { slug: 'app-b' })).resolves.toBeUndefined();
    const hb = await place('pubreq_b');
    await tx((t) =>
      resolveHoldsAtApprove(t, {
        slug: 'app-b',
        actorUserId: HUMAN,
        overrideReason: OVERRIDE,
        shownHoldIds: [hb.id],
      })
    );
    expect((await getOpenHoldCountsBySlug(raw, ['app-a', 'app-b'])).get('app-a')).toBe(1);
  });

  it('🔴 a cleared or overridden hold stops blocking', async () => {
    await addRequest('pubreq_a', 'app-a');
    const h1 = await place('pubreq_a');
    await clearHold(raw, { holdId: h1.id, actorUserId: HUMAN, reason: 'check finished, clean' });
    await expect(checkHoldsBeforeApprove(raw, { slug: 'app-a' })).resolves.toBeUndefined();
    const h2 = await place('pubreq_a');
    await tx((t) =>
      resolveHoldsAtApprove(t, {
        slug: 'app-a',
        actorUserId: HUMAN,
        overrideReason: OVERRIDE,
        shownHoldIds: [h2.id],
      })
    );
    await expect(checkHoldsBeforeApprove(raw, { slug: 'app-a' })).resolves.toBeUndefined();
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

describe('approve claim (on-site approves past their hold check)', () => {
  const claim = (overrides: Record<string, unknown> = {}) =>
    tx((t) =>
      claimApprove(t, {
        slug: 'app-a',
        publishRequestId: 'pubreq_a',
        actorUserId: HUMAN,
        ...overrides,
      })
    );

  it('🔴 refuses a new hold while an approve holds the claim, and allows it once released', async () => {
    await addRequest('pubreq_a', 'app-a');
    const taken = await claim();
    await expect(place('pubreq_a')).rejects.toThrow(/approving this app right now/);
    await releaseApproveClaim(raw, taken);
    await expect(place('pubreq_a')).resolves.toMatchObject({ slug: 'app-a' });
  });

  it('🔴 a second approve of the app is refused while the first holds the claim, and cannot release it', async () => {
    await addRequest('pubreq_a', 'app-a');
    const first = await claim();
    await expect(claim()).rejects.toThrow(/Another approve of this app is already running/);
    await releaseApproveClaim(raw, { slug: 'app-a', token: 'not-the-first-token' });
    await expect(place('pubreq_a')).rejects.toThrow(/approving this app right now/);
    await releaseApproveClaim(raw, first);
    await expect(claim()).resolves.toMatchObject({ slug: 'app-a' });
  });

  it('an expired claim is replaced by the next approve', async () => {
    await addRequest('pubreq_a', 'app-a');
    await claim();
    await db.query(
      `UPDATE app_publish_request_approve_claims SET claimed_at = now() - interval '1 hour'`
    );
    await expect(claim()).resolves.toMatchObject({ slug: 'app-a' });
  });

  it('a claim left by a crashed approve stops blocking after it expires', async () => {
    await addRequest('pubreq_a', 'app-a');
    await claim();
    await db.query(
      `UPDATE app_publish_request_approve_claims SET claimed_at = now() - interval '1 hour'`
    );
    await expect(place('pubreq_a')).resolves.toMatchObject({ slug: 'app-a' });
  });

  it('is refused, and takes no claim, when an open hold was not shown', async () => {
    await addRequest('pubreq_a', 'app-a');
    await place('pubreq_a');
    await expect(claim({ overrideReason: OVERRIDE, shownHoldIds: [] })).rejects.toThrow(
      PublishRequestHeldError
    );
    expect((await db.query('SELECT 1 FROM app_publish_request_approve_claims')).rows).toHaveLength(
      0
    );
  });
});

describe('the per-app lock', () => {
  // pglite is one connection, so no test can race two transactions; instead each entry point is
  // checked to hold the app's advisory lock before its transaction ends.
  async function holdsAppLock(t: Raw, slug: string) {
    const rows = await t.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
        AND classid = ${0x41525648}::bigint::oid AND objsubid = 2
        AND objid = (hashtext(${slug})::bigint & 4294967295)::oid`;
    return rows[0].n > 0;
  }

  it('🔴 placeHold takes it', async () => {
    await addRequest('pubreq_a', 'app-a');
    const locked = await tx(async (t) => {
      await placeHold(t, {
        publishRequestId: 'pubreq_a',
        kind: 'onsite',
        actorUserId: AGENT,
        reason: REASON,
        label: 'code-check',
      });
      return holdsAppLock(t, 'app-a');
    });
    expect(locked).toBe(true);
  });

  it('🔴 claimApprove takes it', async () => {
    await addRequest('pubreq_a', 'app-a');
    const locked = await tx(async (t) => {
      await claimApprove(t, { slug: 'app-a', publishRequestId: 'pubreq_a', actorUserId: HUMAN });
      return holdsAppLock(t, 'app-a');
    });
    expect(locked).toBe(true);
  });

  it('🔴 resolveHoldsAtApprove takes it', async () => {
    await addRequest('pubreq_a', 'app-a');
    const locked = await tx(async (t) => {
      await resolveHoldsAtApprove(t, { slug: 'app-a', actorUserId: HUMAN });
      return holdsAppLock(t, 'app-a');
    });
    expect(locked).toBe(true);
  });

  it('is the lock of that app only, and is released when the transaction ends', async () => {
    await addRequest('pubreq_a', 'app-a');
    const other = await tx(async (t) => {
      await resolveHoldsAtApprove(t, { slug: 'app-a', actorUserId: HUMAN });
      return holdsAppLock(t, 'app-b');
    });
    expect(other).toBe(false);
    expect(await holdsAppLock(raw, 'app-a')).toBe(false);
  });
});

describe('the final check after an on-site approve has committed', () => {
  async function lateHold() {
    await addRequest('pubreq_a', 'app-a');
    await tx((t) =>
      claimApprove(t, { slug: 'app-a', publishRequestId: 'pubreq_a', actorUserId: HUMAN })
    );
    await db.query(
      `UPDATE app_publish_request_approve_claims SET claimed_at = now() - interval '1 hour'`
    );
    return place('pubreq_a');
  }

  it('🔴 does not refuse over a hold placed after the claim expired: returns it as late, leaves it open, and records it', async () => {
    const hold = await lateHold();
    await expect(
      tx((t) =>
        resolveHoldsAtApprove(t, {
          slug: 'app-a',
          actorUserId: HUMAN,
          shownHoldIds: [],
          afterSideEffects: true,
        })
      )
    ).resolves.toEqual({ overridden: [], late: [hold.id] });
    const [row] = (
      await db.query<{ cleared_at: Date | null }>(
        'SELECT cleared_at FROM app_publish_request_holds WHERE id = $1',
        [hold.id]
      )
    ).rows;
    expect(row.cleared_at).toBeNull();
    expect(
      (await db.query('SELECT "userId", activity, "entityType", "entityId" FROM "ModActivity"'))
        .rows
    ).toEqual([
      {
        userId: HUMAN,
        activity: 'publishRequestHoldLateResuspend',
        entityType: 'publishRequestHold',
        entityId: hold.id,
      },
    ]);
  });

  it('a shown hold is still overridden alongside a late one', async () => {
    const shown = await lateHold();
    const late = await place('pubreq_a');
    await expect(
      tx((t) =>
        resolveHoldsAtApprove(t, {
          slug: 'app-a',
          actorUserId: HUMAN,
          shownHoldIds: [shown.id],
          overrideReason: OVERRIDE,
          afterSideEffects: true,
        })
      )
    ).resolves.toEqual({ overridden: [shown.id], late: [late.id] });
  });

  it('still refuses that hold before any side effect', async () => {
    await lateHold();
    await expect(
      tx((t) => resolveHoldsAtApprove(t, { slug: 'app-a', actorUserId: HUMAN, shownHoldIds: [] }))
    ).rejects.toThrow(PublishRequestHeldError);
  });

  it('🔴 the lock wait timeout does not cover the writes after the lock', async () => {
    await addRequest('pubreq_a', 'app-a');
    const timeout = await tx(async (t) => {
      await resolveHoldsAtApprove(t, { slug: 'app-a', actorUserId: HUMAN, afterSideEffects: true });
      return (await t.$queryRaw<{ lock_timeout: string }[]>`SHOW lock_timeout`)[0].lock_timeout;
    });
    expect(timeout).toBe('0');
  });
});
