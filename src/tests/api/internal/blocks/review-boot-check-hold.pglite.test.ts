import { readFileSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuildAttemptsService from '~/server/services/blocks/build-attempts.service';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * 🔴 THE BOOT-CHECK HOLD, end to end: the REAL review-build watcher (boot check included) writes
 * the app's review holds into a real Postgres (PGlite, the holds migration applied), and the
 * REAL approve-path hold checks read them back. Only the checker's HTTP endpoint, the flag value
 * and the preview-state writes are faked.
 *
 * The bypass this pins: a failed check used to be refused only through the preview's detail,
 * which a teardown clears and a rebuild replaces. The hold lives on the app, so neither removes
 * it; a later passed check clears it, and a moderator can override it with a reason.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

type Raw = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

const { mockEnvStore, mockFlag, mockMarkPreview, holder } = vi.hoisted(() => ({
  mockEnvStore: { APP_BLOCK_BOOT_CHECK_URL: 'http://boot-checker.test' } as Record<string, unknown>,
  mockFlag: { bootCheck: 'enforce' as string | null },
  mockMarkPreview: vi.fn(async (..._a: unknown[]) => 1),
  holder: { db: null as unknown as PGlite },
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));
vi.mock('~/env/server', () => ({
  env: new Proxy(mockEnvStore, { get: (t, p: string) => (p in t ? t[p] : undefined) }),
}));
vi.mock('~/server/flipt/client', () => ({
  isFlipt: vi.fn(async () => false),
  getFliptVariant: vi.fn(async (flag: string) =>
    flag === 'app-blocks-review-boot-check' ? mockFlag.bootCheck : null
  ),
  FLIPT_FEATURE_FLAGS: { APP_BLOCKS_REVIEW_BOOT_CHECK: 'app-blocks-review-boot-check' },
}));
vi.mock('~/server/redis/client', () => ({
  redis: { setNxKeepTtlWithEx: vi.fn(async () => true), del: vi.fn(async () => undefined) },
  REDIS_KEYS: { BLOCKS: { TOKEN_RATE_LIMIT: 'blocks:token-rate-limit' } },
}));
vi.mock('~/server/services/blocks/build-attempts.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuildAttemptsService>()),
  isSupersededRun: vi.fn(async () => false),
  recordBuildAttempt: vi.fn(async () => true),
}));
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  triggerApplyReview: vi.fn(),
  waitForApplyJob: vi.fn(),
  waitForReviewHostReachable: vi.fn(async () => true),
  triggerReviewUnpublish: vi.fn(async () => ({ name: 'x' })),
}));
vi.mock('~/server/services/blocks/publish-request.service', () => ({
  markReviewPreviewState: mockMarkPreview,
  releaseSettledBuildSlot: vi.fn(async () => undefined),
  parseReviewDetail: () => ({}),
}));
vi.mock('~/server/db/client', () => {
  const asRaw = (c: unknown) => ({
    $queryRaw: pgliteRaw(c as PGlite).queryRaw,
    $executeRaw: pgliteRaw(c as PGlite).executeRaw,
  });
  return {
    dbRead: {
      appBlockPublishRequest: {
        findUnique: vi.fn(async () => ({ slug: 'app-a', manifest: {} })),
      },
    },
    dbWrite: {
      $transaction: (f: (t: unknown) => Promise<unknown>) =>
        holder.db.transaction((t) => f(asRaw(t))),
    },
  };
});

import { watchDirectPublishedReview } from '~/pages/api/internal/blocks/review-build-callback';
import {
  checkHoldsBeforeApprove,
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
const HELD_MESSAGE = `This app has 1 open review hold: Boot check (civitai): ${HOLD_REASON}. Clear them, or approve with an override reason.`;

let raw: Raw;
const fetchMock = vi.fn();
/** The checker's answer to EVERY call: a fresh Response each time (a body can be read once). */
const checkerSays = (body: unknown, status = 200) =>
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(body), { status }));

/** One review build of this request settling through the real watcher. */
const settle = () =>
  watchDirectPublishedReview({
    publishRequestId: PUBREQ,
    slug: SLUG,
    sha: SHA,
    baseDetail: { sha: SHA, host: HOST, url: `https://${HOST}/${SLUG}` },
    onSettled: () => undefined,
  });

/** The approve path's first hold check, as approveRequest calls it. */
const approveCheck = (opts: { overrideReason?: string; shownHoldIds?: number[] } = {}) =>
  checkHoldsBeforeApprove(raw, { slug: SLUG, ...opts });

const openBootHolds = async () =>
  (await getOpenHoldsBySlug(raw, [SLUG])).filter((h) => h.placedByLabel === 'Boot check');

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    SET TIME ZONE 'UTC';
    CREATE TABLE "User" (id INT PRIMARY KEY, username TEXT);
    INSERT INTO "User" VALUES (-1, 'civitai'), (901, 'mod-human');
    CREATE TABLE app_block_publish_requests (id TEXT PRIMARY KEY, slug TEXT, status TEXT);
    CREATE TABLE app_listing_publish_requests (id TEXT PRIMARY KEY, slug TEXT, status TEXT);
    CREATE TABLE "ModActivity" (
      id SERIAL PRIMARY KEY, "userId" INT, activity TEXT, "entityType" TEXT, "entityId" INT,
      "createdAt" TIMESTAMPTZ DEFAULT now()
    );
  `);
  await holder.db.exec(readFileSync(MIGRATION, 'utf8'));
  raw = {
    $queryRaw: pgliteRaw(holder.db).queryRaw,
    $executeRaw: pgliteRaw(holder.db).executeRaw,
  } as unknown as Raw;
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
  mockFlag.bootCheck = 'enforce';
  vi.stubEnv('NEXTAUTH_SECRET', 'test-nextauth-secret');
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  mockMarkPreview.mockClear();
});

describe('the boot-check hold', () => {
  it('🔴 enforce + failed: places the hold, and approve is refused with its reason', async () => {
    checkerSays(FAILED);
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
    await expect(approveCheck()).rejects.toThrow(HELD_MESSAGE);
    await expect(approveCheck()).rejects.toBeInstanceOf(PublishRequestHeldError);
  });

  it('🔴 teardown does not lift it: the gate reads the app holds, never the preview detail', async () => {
    checkerSays(FAILED);
    await settle();
    // A teardown clears the request's deploy_state and deploy_detail (the only place the result
    // was recorded before the hold existed). The gate's input is the holds table, which no
    // teardown writes: approve is checked here with no preview detail at all.
    await expect(approveCheck()).rejects.toThrow(HELD_MESSAGE);
    expect(await openBootHolds()).toHaveLength(1);
  });

  it('🔴 a rebuild that fails again: still refused, and still ONE hold (no stacking)', async () => {
    checkerSays(FAILED);
    await settle();
    await settle();
    // Both builds really were checked and failed (not a second, unavailable, check).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await openBootHolds()).toHaveLength(1);
    await expect(approveCheck()).rejects.toThrow(HELD_MESSAGE);
  });

  it('🔴 a later passed check clears it (as the system user, with the clear reason): approve allowed', async () => {
    checkerSays(FAILED);
    await settle();
    checkerSays(PASSED);
    await settle();
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
    await expect(approveCheck()).resolves.toBeUndefined();
  });

  it('a pass clears ONLY the boot-check hold: a moderator hold on the app stays open', async () => {
    await holder.db.transaction(async (t) =>
      placeHold(
        {
          $queryRaw: pgliteRaw(t as unknown as PGlite).queryRaw,
          $executeRaw: pgliteRaw(t as unknown as PGlite).executeRaw,
        } as unknown as Raw,
        {
          publishRequestId: PUBREQ,
          kind: 'onsite',
          actorUserId: 901,
          reason: 'security check still running',
          label: 'code-check',
        }
      )
    );
    checkerSays(FAILED);
    await settle();
    checkerSays(PASSED);
    await settle();
    const open = await getOpenHoldsBySlug(raw, [SLUG]);
    expect(open.map((h) => h.placedByLabel)).toEqual(['code-check']);
  });

  it('🔴 a moderator can override it with a written reason (the escape hatch)', async () => {
    checkerSays(FAILED);
    await settle();
    const [hold] = await openBootHolds();
    const override = {
      overrideReason: 'checked by hand, the app loads fine',
      shownHoldIds: [hold.id],
    };
    await expect(approveCheck(override)).resolves.toBeUndefined();
    const resolved = await holder.db.transaction((t) =>
      resolveHoldsAtApprove(
        {
          $queryRaw: pgliteRaw(t as unknown as PGlite).queryRaw,
          $executeRaw: pgliteRaw(t as unknown as PGlite).executeRaw,
        } as unknown as Raw,
        { slug: SLUG, actorUserId: 901, ...override }
      )
    );
    expect(resolved).toEqual({ overridden: [hold.id], late: [] });
  });

  it('🔴 shadow never places a hold, failed or not', async () => {
    mockFlag.bootCheck = 'shadow';
    checkerSays(FAILED);
    await settle();
    expect(await getOpenHoldsBySlug(raw, [SLUG])).toEqual([]);
    await expect(approveCheck()).resolves.toBeUndefined();
  });

  it('enforce + unavailable neither places nor clears a hold', async () => {
    checkerSays(FAILED);
    await settle();
    checkerSays({ error: 'down' }, 503);
    await settle();
    expect(await openBootHolds()).toHaveLength(1);
  }, 30_000);
});
