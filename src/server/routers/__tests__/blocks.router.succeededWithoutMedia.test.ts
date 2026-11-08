import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import client from 'prom-client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * SEAM test for `civitai_app_block_succeeded_without_media_total`: the real
 * `blocks.pollWorkflow` procedure, the REAL `block-workflows.service` (its
 * transition-only UPDATE executed against an in-process Postgres carrying the real
 * `block_workflows` migration), the real snapshot builder and the real prom-client
 * counter. The once-per-workflow property needs all of them together: the poll's
 * terminal branch runs on EVERY poll after completion, and only the SQL decides
 * which poll saw the transition.
 *
 * Everything else is mocked at the module boundary, as in
 * `blocks.router.pollWorkflowLongPoll.test.ts` (this file's scaffold); the text
 * moderation wrapper is an identity. Which workflows count (text-only, failed,
 * canceled, mixed steps) is `workflow.service.succeededWithoutMedia.test.ts`'s job;
 * this file covers the once-per-workflow seam.
 */

const {
  mockVerifyBlockToken,
  mockParseSubjectUserId,
  mockGetOrchestratorToken,
  mockGetWorkflow,
  mockGetUserById,
  mockGetSessionUser,
  mockIsAppBlocksEnabled,
  mockIsAppBlocksAuthorEnabled,
} = vi.hoisted(() => ({
  mockVerifyBlockToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockGetOrchestratorToken: vi.fn(),
  mockGetWorkflow: vi.fn(),
  mockGetUserById: vi.fn(),
  mockGetSessionUser: vi.fn(),
  mockIsAppBlocksEnabled: vi.fn(async () => true),
  mockIsAppBlocksAuthorEnabled: vi.fn(async () => true),
}));

vi.mock('~/server/utils/block-poll-hold-slots', () => ({
  acquireBlockPollHoldSlot: async () => null,
}));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: mockVerifyBlockToken,
  parseSubjectUserId: (...args: unknown[]) => mockParseSubjectUserId(...args),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: mockGetOrchestratorToken,
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  queryWorkflows: vi.fn(),
  getWorkflow: mockGetWorkflow,
  cancelWorkflow: vi.fn(),
  submitWorkflow: vi.fn(),
}));
vi.mock('~/server/services/blocks/custom-comfy-settle.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  settleCustomComfySpend: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/author-fee-charge.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  reverseBlockAuthorFee: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/steps/moderation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  attachModeratedStepTextOutputs: async (snapshot: unknown) => snapshot,
}));
vi.mock('~/server/services/blocks/user-app-surface.service', () => ({
  recordScopeInvocation: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/user.service', () => ({ getUserById: mockGetUserById }));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...args: unknown[]) => mockGetSessionUser(...args) },
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppBlocksAuthorEnabled: mockIsAppBlocksAuthorEnabled,
}));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: async () => ({ allowed: true }),
  checkBlockPollRateLimit: async () => ({ allowed: true }),
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

redisMock.redis.set.mockImplementation(async () => undefined);
redisMock.redis.incr.mockImplementation(async () => 1);
redisMock.redis.incrBy.mockImplementation(async () => 1);
redisMock.redis.decrBy.mockImplementation(async () => 0);
redisMock.redis.expire.mockImplementation(async () => true);
redisMock.redis.ttl.mockImplementation(async () => -1);
redisMock.sysRedis.incrBy.mockImplementation(async () => 0);
redisMock.sysRedis.decrBy.mockImplementation(async () => 0);
redisMock.sysRedis.expire.mockImplementation(async () => true);
redisMock.sysRedis.ttl.mockImplementation(async () => -1);

const METRIC = 'civitai_app_block_succeeded_without_media_total';
const APP_ID = 'oac_01JQ8XG7YV2K4M6P8R0T2W4Y6B';
const TAGS = [`app-block:${APP_ID}`];
const MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20260715130000_block_workflows/migration.sql'
);
const db = { pg: null as unknown as PGlite };

type Readable = {
  get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }>;
};
/** Sum over every step_type: a case that counts under the WRONG label still moves this. */
async function counted(): Promise<number> {
  const m = client.register.getSingleMetric(METRIC) as unknown as Readable | undefined;
  if (!m) return 0;
  return (await m.get()).values.reduce((n, v) => n + v.value, 0);
}
/** comfy with an empty `blobs` list: `reason="absent"`. */
async function countedFor(stepType: string, reason = 'absent'): Promise<number> {
  const m = client.register.getSingleMetric(METRIC) as unknown as Readable | undefined;
  if (!m) return 0;
  return (
    (await m.get()).values.find(
      (v) => v.labels.step_type === stepType && v.labels.reason === reason
    )?.value ?? 0
  );
}

function finished(id: string, status: string, steps: unknown[]) {
  return { id, status, cost: { total: 9 }, steps, tags: TAGS };
}
const comfyStep = (blobs: unknown[]) => ({
  $type: 'comfy',
  name: 's1',
  status: 'succeeded',
  metadata: {},
  output: { blobs },
});

function validClaims() {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:42',
    iat: 0,
    exp: 0,
    jti: 'jti_test',
    blockId: 'some-block',
    appId: APP_ID,
    appBlockId: 'apb_01JQ8XG7YV2K4M6P8R0T2W4Y6A',
    blockInstanceId: 'bki_01JQ8XG7YV2K4M6P8R0T2W4Y6C',
    ctx: { slotId: 'none', entityType: 'none' },
    scopes: ['ai:write:budgeted'],
    buzzBudget: 50,
    maxBrowsingLevel: sfwBrowsingLevelsFlag,
  };
}
const caller = () =>
  blocksRouter.createCaller({
    acceptableOrigin: true,
    user: undefined,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: { canViewNsfw: false, isBlue: false, isGreen: false, isGreenSession: false } as never,
    track: undefined,
  } as never);

/** Polls `workflow` `times` times, with a `block_workflows` row submitted as `pending`. */
async function pollRepeatedly(workflow: { id: string }, times: number) {
  await db.pg.query(
    `INSERT INTO "block_workflows" ("workflow_id", "app_block_id", "block_instance_id", "user_id", "status")
     VALUES ($1, 'apb_01JQ8XG7YV2K4M6P8R0T2W4Y6A', 'bki_01JQ8XG7YV2K4M6P8R0T2W4Y6C', 42, 'pending')`,
    [workflow.id]
  );
  mockGetWorkflow.mockResolvedValue(workflow);
  const statuses: string[] = [];
  for (let i = 0; i < times; i++) {
    const { snapshot } = await caller().pollWorkflow({
      blockToken: 'tok',
      workflowId: workflow.id,
    });
    statuses.push(snapshot.status);
  }
  return statuses;
}

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TABLE "app_blocks" ("id" text PRIMARY KEY);
    CREATE TABLE "User" ("id" integer PRIMARY KEY);
    INSERT INTO "app_blocks" ("id") VALUES ('apb_01JQ8XG7YV2K4M6P8R0T2W4Y6A');
    INSERT INTO "User" ("id") VALUES (42);
  `);
  await db.pg.exec(readFileSync(MIGRATION, 'utf8'));
});

beforeEach(async () => {
  await db.pg.exec(`DELETE FROM "block_workflows";`);
  dbMock.dbWrite.$executeRaw.mockImplementation(pgliteRaw(db.pg).executeRaw as never);
  dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ status: 'approved' } as never);
  mockVerifyBlockToken.mockReset().mockResolvedValue(validClaims());
  mockParseSubjectUserId.mockReset().mockImplementation(() => 42);
  mockGetOrchestratorToken.mockReset().mockResolvedValue('orch_token');
  mockGetUserById.mockReset().mockResolvedValue({ id: 42, isModerator: true, tier: 'free' });
  mockGetSessionUser.mockReset().mockResolvedValue({ id: 42, isModerator: true, tier: 'free' });
  mockIsAppBlocksEnabled.mockImplementation(async () => true);
  mockIsAppBlocksAuthorEnabled.mockImplementation(async () => true);
  mockGetWorkflow.mockReset();
});

describe('blocks.pollWorkflow → civitai_app_block_succeeded_without_media_total', () => {
  it('🔴 counts a succeeded-without-media workflow EXACTLY ONCE across repeated terminal polls', async () => {
    const before = await countedFor('comfy');
    const statuses = await pollRepeatedly(finished('wf_nomedia', 'succeeded', [comfyStep([])]), 4);

    // Positive control: all four polls reached the terminal branch.
    expect(statuses).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded']);
    expect(await countedFor('comfy')).toBe(before + 1);
    // And the read-model row DID transition, which is what gated the count.
    const row = await db.pg.query<{ status: string }>(
      `SELECT "status" FROM "block_workflows" WHERE "workflow_id" = 'wf_nomedia'`
    );
    expect(row.rows[0]?.status).toBe('succeeded');
  });

  it('a second, distinct succeeded-without-media workflow is counted again (once)', async () => {
    const before = await countedFor('comfy');
    await pollRepeatedly(finished('wf_nomedia_a', 'succeeded', [comfyStep([])]), 2);
    await pollRepeatedly(finished('wf_nomedia_b', 'succeeded', [comfyStep([])]), 3);
    expect(await countedFor('comfy')).toBe(before + 2);
  });

  it('NOT counted when the images arrived', async () => {
    const before = await counted();
    await pollRepeatedly(
      finished('wf_media', 'succeeded', [
        comfyStep([{ id: 'b', type: 'image', url: 'https://cdn/x.png', available: true }]),
      ]),
      3
    );
    expect(await counted()).toBe(before);
  });

  it('NOT counted when the workflow has no block_workflows row (nothing transitioned)', async () => {
    const before = await counted();
    mockGetWorkflow.mockResolvedValue(finished('wf_norow', 'succeeded', [comfyStep([])]));
    await caller().pollWorkflow({ blockToken: 'tok', workflowId: 'wf_norow' });
    expect(await counted()).toBe(before);
  });
});
