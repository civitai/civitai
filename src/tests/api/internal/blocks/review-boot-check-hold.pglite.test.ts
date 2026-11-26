import { readFileSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as FliptClient from '~/server/flipt/client';

/**
 * 🔴 THE BOOT-CHECK HOLD, end to end. The REAL review-build watcher (the real HTTP probe, boot
 * check, guarded preview-state write and hold sync) runs against a real Postgres (PGlite, the
 * holds migration applied), and the REAL approve gate (`checkReviewGatesBeforeApprove`: the
 * app's holds, then the request's recorded preview) reads it back. Faked: the network (fetch:
 * the preview answers 200, the checker answers per test), the flag store, and the Prisma
 * delegate calls, which run as SQL against the same database with the real guard's semantics.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

type Raw = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

const { mockFlag, holder } = vi.hoisted(() => ({
  mockFlag: { bootCheck: 'enforce' as string | null },
  holder: { db: null as unknown as PGlite },
}));

// The flag store is a process boundary.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: async () => false,
  getFliptVariant: async (flag: string) =>
    flag === 'app-blocks-review-boot-check' ? mockFlag.bootCheck : null,
}));

import { watchDirectPublishedReview } from '~/pages/api/internal/blocks/review-build-callback';
import {
  checkReviewGatesBeforeApprove,
  getOpenHoldsBySlug,
  placeHold,
  PublishRequestHeldError,
  resolveHoldsAtApprove,
} from '~/server/services/blocks/publish-request-holds.service';

const MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20270114120000_app_publish_request_holds/migration.sql'
);
const SLUG = 'app-a';
const PUBREQ = 'pubreq_0123456789ABCDEFGHJKMNPQRS';
const SHA = 'a'.repeat(40);
const NEWER_SHA = 'b'.repeat(40);
const HOST = 'review-abc123def4567890.civit.ai';
const SYSTEM = -1;
const MIME_ERROR =
  'Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "application/octet-stream".';
const FAILED = {
  result: 'failed',
  ms: 10012,
  messagesSeen: ['BLOCK_HELLO'],
  consoleErrors: [MIME_ERROR],
  failedRequests: [],
  nonJsModuleResponses: 1,
  blockedScripts: [],
};
const PASSED = { ...FAILED, result: 'passed', consoleErrors: [], nonJsModuleResponses: 0 };
const HOLD_REASON =
  'The app loaded but never sent BLOCK_READY within 10s (first error: Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "application/octet-stream"). A build of this app that passes the boot check clears this hold';
const HELD_MESSAGE =
  'This app has 1 open review hold: Boot check (civitai): The app loaded but never sent BLOCK_READY within 10s (first error: Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "application/octet-stream"). A build of this app that passes the boot check clears this hold. Clear them, or approve with an override reason.';
const DETAIL_REFUSAL =
  'The boot check found that this build never finishes loading (no BLOCK_READY). To approve anyway, give an override reason.';
const OVERRIDE = 'checked by hand, the app loads fine';

let raw: Raw;
/** Test hooks on the preview-state write: fail it, or run something right after it lands. */
const writeHooks: { fail: boolean; after: null | (() => Promise<unknown>) } = {
  fail: false,
  after: null,
};
const asRaw = (c: unknown) =>
  ({
    $queryRaw: pgliteRaw(c as PGlite).queryRaw,
    $executeRaw: pgliteRaw(c as PGlite).executeRaw,
  } as unknown as Raw);

/** The network: the preview itself answers 200; the checker answers `checker` (fresh each call). */
const fetchMock = vi.fn();
let checker: { status: number; body: unknown } = { status: 200, body: FAILED };
const checkerSays = (body: unknown, status = 200) => {
  checker = { status, body };
};
const checkerCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/boot-check')).length;

/** One review build of this request settling through the real watcher. */
const settle = (sha = SHA) =>
  watchDirectPublishedReview({
    publishRequestId: PUBREQ,
    slug: SLUG,
    sha,
    baseDetail: { sha, host: HOST, url: `https://${HOST}/${SLUG}` },
    onSettled: () => undefined,
  });

/** A build of `sha` is the request's active preview (as previewRequest leaves it). */
const activeBuild = (sha: string) =>
  holder.db.query(
    `UPDATE app_block_publish_requests SET status = 'pending', deploy_state = 'preview-deploying',
       deploy_detail = $2 WHERE id = $1`,
    [PUBREQ, JSON.stringify({ sha, host: HOST, url: `https://${HOST}/${SLUG}` })]
  );

/** What a teardown does to the row: the preview state and its detail are gone. */
const tearDown = () =>
  holder.db.query(
    `UPDATE app_block_publish_requests SET deploy_state = NULL, deploy_detail = NULL WHERE id = $1`,
    [PUBREQ]
  );

/** The on-site approve's first gate, as approveRequest calls it. */
const approveGate = (opts: { overrideReason?: string; shownHoldIds?: number[] } = {}) =>
  checkReviewGatesBeforeApprove(raw, { slug: SLUG, publishRequestId: PUBREQ, ...opts });

const openBootHolds = async () =>
  (await getOpenHoldsBySlug(raw, [SLUG])).filter((h) => h.placedByLabel === 'Boot check');

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    SET TIME ZONE 'UTC';
    CREATE TABLE "User" (id INT PRIMARY KEY, username TEXT);
    INSERT INTO "User" VALUES (-1, 'civitai'), (901, 'mod-human');
    CREATE TABLE app_block_publish_requests (
      id TEXT PRIMARY KEY, slug TEXT, status TEXT, deploy_state TEXT, deploy_detail TEXT
    );
    CREATE TABLE app_listing_publish_requests (id TEXT PRIMARY KEY, slug TEXT, status TEXT);
    CREATE TABLE "ModActivity" (
      id SERIAL PRIMARY KEY, "userId" INT, activity TEXT, "entityType" TEXT, "entityId" INT,
      "createdAt" TIMESTAMPTZ DEFAULT now()
    );
  `);
  await holder.db.exec(readFileSync(MIGRATION, 'utf8'));
  raw = asRaw(holder.db);
});
afterAll(() => holder.db.close());

beforeEach(async () => {
  await holder.db.exec(`
    TRUNCATE app_publish_request_holds, app_publish_request_approve_claims,
      app_block_publish_requests, "ModActivity" RESTART IDENTITY;
  `);
  await holder.db.query(
    `INSERT INTO app_block_publish_requests (id, slug, status) VALUES ($1, $2, 'pending')`,
    [PUBREQ, SLUG]
  );
  await activeBuild(SHA);
  mockFlag.bootCheck = 'enforce';
  writeHooks.fail = false;
  writeHooks.after = null;
  checkerSays(FAILED);
  envMock.set({
    APP_BLOCK_BOOT_CHECK_URL: 'http://boot-checker.test',
    APPS_REVIEW_INGRESS_TARGET: undefined,
    APPS_DEV_TUNNEL_INGRESS_TARGET: undefined,
  });
  vi.stubEnv('NEXTAUTH_SECRET', 'test-nextauth-secret');
  fetchMock.mockImplementation(async (url: unknown) =>
    String(url).endsWith('/v1/boot-check')
      ? new Response(JSON.stringify(checker.body), { status: checker.status })
      : new Response('<!doctype html>', { status: 200 })
  );
  vi.stubGlobal('fetch', fetchMock);

  // The Prisma delegate calls the watcher makes, as SQL on the same database.
  dbMock.dbWrite.$transaction.mockImplementation(((f: (t: unknown) => Promise<unknown>) =>
    holder.db.transaction((t) => f(asRaw(t)))) as never);
  dbMock.dbRead.appBlockPublishRequest.findUnique.mockImplementation((async () => ({
    slug: SLUG,
    manifest: {},
  })) as never);
  dbMock.dbWrite.appBlockPublishRequest.updateMany.mockImplementation((async (args: {
    where: {
      id: string;
      status?: string;
      OR?: unknown;
      deployState?: { startsWith: string };
      deployDetail?: { contains: string };
    };
    data: { deployState: string | null; deployDetail: string | null };
  }) => {
    // The build-slot release (`OR` shape) only matches rows that are not an active pending
    // preview; every row here is one, so it matches nothing, as it would.
    if (args.where.OR) return { count: 0 };
    if (writeHooks.fail) throw new Error('connection reset');
    // markReviewPreviewState's guarded write, with the real guard's semantics.
    const res = await holder.db.query(
      `UPDATE app_block_publish_requests SET deploy_state = $2, deploy_detail = $3
       WHERE id = $1
         AND ($4::text IS NULL OR status = $4)
         AND ($5::text IS NULL OR deploy_state LIKE $5 || '%')
         AND ($6::text IS NULL OR strpos(deploy_detail, $6) > 0)`,
      [
        args.where.id,
        args.data.deployState,
        args.data.deployDetail,
        args.where.status ?? null,
        args.where.deployState?.startsWith ?? null,
        args.where.deployDetail?.contains ?? null,
      ]
    );
    if (writeHooks.after) await writeHooks.after();
    return { count: res.affectedRows ?? 0 };
  }) as never);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('the boot-check hold', () => {
  it('🔴 enforce + failed: places the hold, and approve is refused with its reason', async () => {
    await settle();
    const holds = await openBootHolds();
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({
      publishRequestId: PUBREQ,
      requestKind: 'onsite',
      placedByUserId: SYSTEM,
      placedByLabel: 'Boot check',
      reason: HOLD_REASON,
    });
    await expect(approveGate()).rejects.toThrow(HELD_MESSAGE);
    await expect(approveGate()).rejects.toBeInstanceOf(PublishRequestHeldError);
  });

  it('🔴 a REAL teardown (preview state and detail gone) does not lift it', async () => {
    await settle();
    await tearDown();
    const [row] = (
      await holder.db.query<{ deploy_state: string | null; deploy_detail: string | null }>(
        `SELECT deploy_state, deploy_detail FROM app_block_publish_requests WHERE id = $1`,
        [PUBREQ]
      )
    ).rows;
    expect(row).toEqual({ deploy_state: null, deploy_detail: null });
    // Only the hold can refuse now: the recorded failure is gone with the detail.
    await expect(approveGate()).rejects.toThrow(HELD_MESSAGE);
  });

  it('🔴 a rebuild that fails again: still refused, and still ONE hold (no stacking)', async () => {
    await settle();
    await activeBuild(NEWER_SHA);
    await settle(NEWER_SHA);
    // Both builds really were checked and failed (not a second, unavailable, check).
    expect(checkerCalls()).toBe(2);
    expect(await openBootHolds()).toHaveLength(1);
    await tearDown();
    await expect(approveGate()).rejects.toThrow(HELD_MESSAGE);
  });

  it('🔴 a later passed check of the active build clears it (as the system user, with the clear reason)', async () => {
    await settle();
    await activeBuild(NEWER_SHA);
    checkerSays(PASSED);
    await settle(NEWER_SHA);
    expect(await openBootHolds()).toHaveLength(0);
    const [row] = (
      await holder.db.query<{
        cleared_kind: string;
        cleared_reason: string;
        cleared_by_user_id: number;
      }>(`SELECT cleared_kind, cleared_reason, cleared_by_user_id FROM app_publish_request_holds`)
    ).rows;
    expect(row).toEqual({
      cleared_kind: 'cleared',
      cleared_reason: 'A later build of this app passed the boot check.',
      cleared_by_user_id: SYSTEM,
    });
    await expect(approveGate()).resolves.toEqual({ bootCheckOverridden: false });
  });

  it("🔴 a STALE watcher's pass (an older build) does not clear the newer failure's hold", async () => {
    // The newer build is active and failed: it holds the app.
    await activeBuild(NEWER_SHA);
    await settle(NEWER_SHA);
    expect(await openBootHolds()).toHaveLength(1);
    // The older build's watcher, still running, passes late.
    checkerSays(PASSED);
    await settle(SHA);
    expect(await openBootHolds()).toHaveLength(1);
    await expect(approveGate()).rejects.toThrow(HELD_MESSAGE);
  });

  it("🔴 a STALE watcher's failure (an older build) does not place a hold over the newer pass", async () => {
    await activeBuild(NEWER_SHA);
    checkerSays(PASSED);
    await settle(NEWER_SHA);
    checkerSays(FAILED);
    await settle(SHA);
    expect(await openBootHolds()).toHaveLength(0);
    await expect(approveGate()).resolves.toEqual({ bootCheckOverridden: false });
  });

  it("🔴 a newer build takes over between this watcher's write and its hold sync: the hold is not moved", async () => {
    // This watcher's guarded write matches (it owned the preview then); a rebuild replaces the
    // preview right after. Only the hold write's own in-transaction ownership check sees it.
    writeHooks.after = () => activeBuild(NEWER_SHA);
    await settle(SHA);
    expect(await openBootHolds()).toHaveLength(0);
  });

  it('🔴 the preview write itself fails (ownership unknown): the hold is not moved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      writeHooks.fail = true;
      await settle(SHA);
    } finally {
      warn.mockRestore();
    }
    expect(await openBootHolds()).toHaveLength(0);
  });

  it('a stale watcher of a WITHDRAWN request places nothing', async () => {
    await holder.db.query(
      `UPDATE app_block_publish_requests SET status = 'withdrawn' WHERE id = $1`,
      [PUBREQ]
    );
    await settle();
    expect(await getOpenHoldsBySlug(raw, [SLUG])).toEqual([]);
  });

  it('a pass clears ONLY the boot-check hold: a moderator hold on the app stays open', async () => {
    await holder.db.transaction(async (t) =>
      placeHold(asRaw(t), {
        publishRequestId: PUBREQ,
        kind: 'onsite',
        actorUserId: 901,
        reason: 'security check still running',
        label: 'code-check',
      })
    );
    await settle();
    await activeBuild(NEWER_SHA);
    checkerSays(PASSED);
    await settle(NEWER_SHA);
    const open = await getOpenHoldsBySlug(raw, [SLUG]);
    expect(open.map((h) => h.placedByLabel)).toEqual(['code-check']);
  });

  it('🔴 a moderator can override it with a written reason (the escape hatch)', async () => {
    await settle();
    const [hold] = await openBootHolds();
    const override = { overrideReason: OVERRIDE, shownHoldIds: [hold.id] };
    await expect(approveGate(override)).resolves.toEqual({ bootCheckOverridden: true });
    const resolved = await holder.db.transaction((t) =>
      resolveHoldsAtApprove(asRaw(t), { slug: SLUG, actorUserId: 901, ...override })
    );
    expect(resolved).toEqual({ overridden: [hold.id], late: [] });
  });

  it('🔴 the hold write fails: the RECORDED failure still refuses, and the same override passes it', async () => {
    // A moderator approve of this app is in flight: placeHold refuses to place a hold.
    await holder.db.query(
      `INSERT INTO app_publish_request_approve_claims
         (slug, publish_request_id, claimed_by_user_id, claimed_at, claim_token)
       VALUES ($1, $2, 901, now(), 'tok')`,
      [SLUG, PUBREQ]
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await settle();
    } finally {
      error.mockRestore();
    }
    expect(await openBootHolds()).toHaveLength(0);
    await expect(approveGate()).rejects.toThrow(DETAIL_REFUSAL);
    await expect(approveGate({ overrideReason: OVERRIDE, shownHoldIds: [] })).resolves.toEqual({
      bootCheckOverridden: true,
    });
  });

  it('🔴 shadow never places a hold, failed or not', async () => {
    mockFlag.bootCheck = 'shadow';
    await settle();
    expect(await getOpenHoldsBySlug(raw, [SLUG])).toEqual([]);
    await expect(approveGate()).resolves.toEqual({ bootCheckOverridden: false });
  });

  it('enforce + unavailable neither places nor clears a hold', async () => {
    await settle();
    await activeBuild(NEWER_SHA);
    checkerSays({ error: 'down' }, 503);
    await settle(NEWER_SHA);
    expect(await openBootHolds()).toHaveLength(1);
  }, 30_000);
});
