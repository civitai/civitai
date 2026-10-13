import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Setup-order import: shared db/redis/env/prom mocks and the REAL test RSA keypair, so the
// tokens below are really signed and the procedures really verify them.
import '~/__tests__/setup';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';
import type * as ConsentRevocationModule from '~/server/services/blocks/consent-revocation.service';
import type * as DevTunnelModule from '~/server/services/blocks/dev-tunnel.service';
import type * as CatalogRateLimit from '~/server/utils/block-catalog-rate-limit';
import type * as SharedRateLimit from '~/server/utils/shared-storage-rate-limit';

/**
 * CHARACTERISATION — every tRPC procedure that takes a `blockToken`, today.
 *
 * Three routers: `blocks.*` (the postMessage bridge, authorized by `authorizeBlockBridgeToken`),
 * `apps.storage.*` (per-user storage, `resolveStorageContext`) and `apps.shared.*` (shared
 * storage, `resolveSharedContext`). Each is driven through a real tRPC caller with a REAL
 * minted RS256 block token, and each cell records the procedure's result (or its TRPCError
 * code + message) and every rate-limiter call it made, in order, with arguments.
 *
 * Why the limiter arguments are part of every cell: the bucket a request is charged to IS its
 * arguments (`blockInstanceId`, subject id, app block id). A consolidated resolver that hands a
 * procedure different claims, or that runs a limiter before or after a different refusal, moves
 * a cell here even when the response code does not change.
 *
 * The population is DERIVED at run time from the routers' own procedure definitions (every
 * procedure whose input schema has a `blockToken` key) and asserted equal to this table's keys,
 * so a procedure added without a row fails.
 *
 * The deliberate resolver differences behind these cells are quoted in the header of
 * `src/server/services/blocks/__tests__/block-token-auth.characterisation.resolvers.test.ts`.
 *
 * ## How to read a PASSED cell
 *
 * A cell the auth path did not refuse continues into the procedure body, whose answer depends
 * on services this file does not set up. Those are pinned as PASSED: the limiter calls made and
 * that the outcome is NOT a refusal code (UNAUTHORIZED / FORBIDDEN / TOO_MANY_REQUESTS /
 * SERVICE_UNAVAILABLE). Refusals are pinned verbatim.
 */

const h = vi.hoisted(() => ({
  isRevoked: vi.fn(),
  consentLookup: vi.fn(),
  getActiveDevTunnel: vi.fn(),
  getSessionUserById: vi.fn(),
  runFlag: { on: true },
  limiter: { deny: false },
  limiterCalls: [] as string[],
}));

vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof AppBlocksFlag>()),
  isAppBlocksEnabled: async () => h.runFlag.on,
  isAppBlocksSharedStorageEnabled: async () => h.runFlag.on,
  isAppBlocksAuthorEnabled: async () => false,
  isAppBlocksPostCreationEnabled: async () => h.runFlag.on,
  isAppBlocksTrainingKindEnabled: async () => h.runFlag.on,
  isAppBlocksConfirmedStepEnabled: async () => h.runFlag.on,
}));
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: { isRevoked: (...a: unknown[]) => h.isRevoked(...a) },
}));
vi.mock('~/server/services/blocks/consent-revocation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ConsentRevocationModule>()),
  ConsentRevocation: { lookup: (...a: unknown[]) => h.consentLookup(...a) },
}));
vi.mock('~/server/services/blocks/dev-tunnel.service', async (importOriginal) => ({
  ...(await importOriginal<typeof DevTunnelModule>()),
  getActiveDevTunnel: (...a: unknown[]) => h.getActiveDevTunnel(...a),
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...a: unknown[]) => h.getSessionUserById(...a) },
}));

function limiterSpy(name: string) {
  return async (...args: unknown[]) => {
    h.limiterCalls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
    if (h.limiter.deny) return { allowed: false, retryAfterSeconds: 7 };
    return name === 'reserveSharedWrite'
      ? { allowed: true, release: async () => undefined }
      : { allowed: true };
  };
}
vi.mock('~/server/utils/block-catalog-rate-limit', async (importOriginal) => {
  const real = await importOriginal<typeof CatalogRateLimit>();
  const out: Record<string, unknown> = { ...real };
  for (const k of Object.keys(real)) if (/^check.*RateLimit$/.test(k)) out[k] = limiterSpy(k);
  return out;
});
vi.mock('~/server/utils/shared-storage-rate-limit', async (importOriginal) => {
  const real = await importOriginal<typeof SharedRateLimit>();
  const out: Record<string, unknown> = { ...real };
  for (const k of Object.keys(real))
    if (/^check.*RateLimit$/.test(k) || k === 'reserveSharedWrite') out[k] = limiterSpy(k);
  return out;
});

import { dbMock } from '~/__tests__/mocks/db.mock';
import { BlockTokenService } from '~/server/services/block-token.service';
import { blocksRouter } from '~/server/routers/blocks.router';
import { appsRouter } from '~/server/routers/apps.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { OnboardingSteps } from '~/server/common/enums';

// ── fixture ──────────────────────────────────────────────────────────────────────────────

const SUBJECT_ID = 42;
const SUBJECT = {
  id: SUBJECT_ID,
  username: 'char',
  isModerator: false,
  tier: 'free',
  onboarding: OnboardingSteps.Buzz | OnboardingSteps.TOS,
  emailVerified: new Date('2020-01-01T00:00:00Z'),
  createdAt: new Date('2020-01-01T00:00:00Z'),
  bannedAt: null,
  muted: false,
};

/** Every scope any of the 39 procedures checks, so the baseline token is refused by none. */
const ALL_SCOPES = [
  'ai:write:budgeted',
  'buzz:read:self',
  'user:read:self',
  'posts:write:self',
  'models:read:self',
  'apps:storage:read',
  'apps:storage:write',
  'apps:storage:shared:read',
  'apps:storage:shared:write',
];

/**
 * Procedures that serve PAGE apps only (`isPageToken`: `ctx.entityType === 'none'`). They get a
 * page-context token, or every cell would stop at the page-only refusal and pin nothing else.
 */
const PAGE_PROCS = new Set([
  'blocks.persistAppUploadImage',
  'blocks.prepareTrainingDataset',
  'blocks.previewTrainingQuote',
  'blocks.consentTrainingQuote',
  'blocks.previewQuoteGrant',
  'blocks.consentQuoteGrant',
]);
let currentPath = '';

async function mint(over: { scopes?: string[]; anon?: boolean } = {}) {
  const { token } = await BlockTokenService.sign({
    userId: over.anon ? null : SUBJECT_ID,
    blockId: 'char-block',
    appId: 'app_char',
    appBlockId: 'apb_char',
    blockInstanceId: 'bki_char',
    scopes: over.scopes ?? ALL_SCOPES,
    ctx: PAGE_PROCS.has(currentPath)
      ? { entityType: 'none' }
      : { modelId: 7, slotId: 'model.sidebar_top' },
    maxBrowsingLevel: 1,
    buzzBudget: 100,
  } as Parameters<typeof BlockTokenService.sign>[0]);
  return token;
}

const WORKFLOW_BODY = {
  kind: 'textToImage',
  modelId: 7,
  modelVersionId: 99,
  params: { prompt: 'a cat', quantity: 1 },
};
const QUOTE_ID = `tq_${'a'.repeat(32)}`;
const POST_PAYLOAD = { sources: [{ kind: 'published', imageIds: [1] }] };

/** Minimal input (minus `blockToken`) each procedure's schema accepts. */
const INPUTS: Record<string, Record<string, unknown>> = {
  'blocks.cancelAppWorkflow': { workflowId: 'wf_1' },
  'blocks.cancelWorkflow': { workflowId: 'wf_1' },
  'blocks.consentQuoteGrant': { kind: 'training', quoteId: QUOTE_ID },
  'blocks.consentTrainingQuote': { quoteId: QUOTE_ID },
  'blocks.createPostFromApp': { ...POST_PAYLOAD, confirmedImageCount: 1 },
  'blocks.estimateWorkflow': { body: WORKFLOW_BODY },
  'blocks.estimateWorkflowBatch': { bodies: [WORKFLOW_BODY] },
  'blocks.getImagesByIds': { imageIds: [1] },
  'blocks.getMyBuzzAccounts': {},
  'blocks.getMyBuzzBalance': {},
  'blocks.getMyBuzzTransactions': {},
  'blocks.getMyDailyCompensation': { date: '2026-01-01' },
  'blocks.getMyViewer': {},
  'blocks.listMyWorkflows': {},
  'blocks.persistAppUploadImage': { url: '00000000-0000-4000-8000-000000000000' },
  'blocks.pollWorkflow': { workflowId: 'wf_1' },
  'blocks.prepareTrainingDataset': { items: [{ imageId: 1, caption: 'c' }] },
  'blocks.previewPostFromApp': POST_PAYLOAD,
  'blocks.previewQuoteGrant': { kind: 'training', quoteId: QUOTE_ID },
  'blocks.previewTrainingQuote': { quoteId: QUOTE_ID },
  'blocks.publishGenerationOutputs': { workflowId: 'wf_1' },
  'blocks.queryAppWorkflows': {},
  'blocks.submitWorkflow': { body: WORKFLOW_BODY, idempotencyKey: 'idem_char' },
  'blocks.updateUserSettings': { settings: { a: 1 } },
  'apps.storage.get': { key: 'k' },
  'apps.storage.set': { key: 'k', value: 1 },
  'apps.storage.delete': { key: 'k' },
  'apps.storage.list': {},
  'apps.storage.getQuota': {},
  'apps.shared.list': {},
  'apps.shared.get': { key: 'k' },
  'apps.shared.getCount': { key: 'k' },
  'apps.shared.getCounts': { keys: ['k'] },
  'apps.shared.append': { value: { title: 't' } },
  'apps.shared.update': { key: 'k', value: { title: 't' } },
  'apps.shared.vote': { key: 'k' },
  'apps.shared.unvote': { key: 'k' },
  'apps.shared.withdraw': { key: 'k' },
  'apps.shared.report': { key: 'k' },
};

function ctx() {
  return {
    acceptableOrigin: true,
    user: { ...SUBJECT },
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}

/** `blocks.x` / `apps.storage.x` → the bound caller function. */
function procFn(path: string): (input: unknown) => Promise<unknown> {
  const [root, ...rest] = path.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any =
    root === 'blocks'
      ? blocksRouter.createCaller(ctx() as never)
      : appsRouter.createCaller(ctx() as never);
  for (const seg of rest) node = node[seg];
  return node as (input: unknown) => Promise<unknown>;
}

type Outcome = {
  result: { ok: true } | { error: string; code?: string; message: string };
  limiter: string[];
};

async function invoke(path: string, token: string): Promise<Outcome> {
  h.limiterCalls.length = 0;
  let result: Outcome['result'];
  try {
    await procFn(path)({ blockToken: token, ...INPUTS[path] });
    result = { ok: true };
  } catch (err) {
    const e = err as { constructor?: { name?: string }; code?: unknown; message?: unknown };
    result = {
      error: e?.constructor?.name ?? typeof err,
      ...(typeof e?.code === 'string' ? { code: e.code } : {}),
      message: String(e?.message),
    };
  }
  return { result, limiter: [...h.limiterCalls] };
}

// ── population, derived from the routers themselves ──────────────────────────────────────

/** Does this zod schema (or anything it wraps) declare a `blockToken` key? */
function hasBlockTokenKey(schema: unknown, depth = 0): boolean {
  if (!schema || typeof schema !== 'object' || depth > 8) return false;
  const s = schema as {
    shape?: Record<string, unknown>;
    options?: unknown[];
    def?: { innerType?: unknown; in?: unknown; schema?: unknown; options?: unknown[] };
    _def?: { innerType?: unknown; schema?: unknown };
  };
  if (s.shape && typeof s.shape === 'object' && 'blockToken' in s.shape) return true;
  const kids = [
    ...(Array.isArray(s.options) ? s.options : []),
    ...(Array.isArray(s.def?.options) ? s.def!.options! : []),
    s.def?.innerType,
    s.def?.in,
    s.def?.schema,
    s._def?.innerType,
    s._def?.schema,
  ];
  return kids.some((k) => hasBlockTokenKey(k, depth + 1));
}

function blockTokenProcedures(prefix: string, router: unknown): string[] {
  const procs = (router as { _def: { procedures: Record<string, unknown> } })._def.procedures;
  return Object.entries(procs)
    .filter(([, p]) => {
      const inputs = (p as { _def?: { inputs?: unknown[] } })._def?.inputs ?? [];
      return inputs.some((i) => hasBlockTokenKey(i));
    })
    .map(([name]) => `${prefix}.${name}`);
}

// ── world ────────────────────────────────────────────────────────────────────────────────

const FROZEN_NOW = new Date('2026-01-01T00:00:00.000Z');

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FROZEN_NOW);
  h.runFlag.on = true;
  h.limiter.deny = false;
  h.limiterCalls.length = 0;
  h.isRevoked.mockReset().mockResolvedValue(false);
  h.consentLookup.mockReset().mockResolvedValue({ kind: 'none' });
  h.getActiveDevTunnel.mockReset().mockResolvedValue(null);
  h.getSessionUserById.mockReset().mockResolvedValue({ ...SUBJECT });
  dbMock.dbRead.appBlock.findUnique.mockReset().mockResolvedValue({
    id: 'apb_char',
    status: 'approved',
  });
  dbMock.dbRead.oauthClient.findUnique.mockReset().mockResolvedValue({ userId: SUBJECT_ID });
  // The subject's own user row, for the procedures that look the viewer up after auth.
  dbMock.dbRead.user.findUnique.mockReset().mockResolvedValue({ ...SUBJECT, deletedAt: null });
  dbMock.dbWrite.user.findUnique.mockReset().mockResolvedValue({ ...SUBJECT, deletedAt: null });
});

type CellName =
  | 'valid token'
  | 'garbage token'
  | 'revoked'
  | 'not approved'
  | 'missing scope'
  | 'anonymous subject'
  | 'flag off'
  | 'rate limited';

const CELLS: Record<CellName, (path: string) => Promise<Outcome>> = {
  'valid token': async (p) => invoke(p, await mint()),
  'garbage token': (p) => invoke(p, 'not-a-jwt'),
  revoked: async (p) => {
    h.isRevoked.mockResolvedValue(true);
    return invoke(p, await mint());
  },
  'not approved': async (p) => {
    dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ id: 'apb_char', status: 'suspended' });
    return invoke(p, await mint());
  },
  'missing scope': async (p) => invoke(p, await mint({ scopes: [] })),
  'anonymous subject': async (p) => invoke(p, await mint({ anon: true })),
  'flag off': async (p) => {
    h.runFlag.on = false;
    return invoke(p, await mint());
  },
  'rate limited': async (p) => {
    h.limiter.deny = true;
    return invoke(p, await mint());
  },
};

// ── expectations ─────────────────────────────────────────────────────────────────────────

type Expect =
  | { kind: 'ok'; limiter: string[] }
  | { kind: 'error'; code: string; message: string; limiter: string[] }
  | { kind: 'passed'; limiter: string[] };

/** Resolved. */
const OK = (limiter: string[]): Expect => ({ kind: 'ok', limiter });
/** Refused with exactly this TRPCError code and message. */
const E = (code: string, message: string, limiter: string[]): Expect => ({
  kind: 'error',
  code,
  message,
  limiter,
});
/**
 * Not refused by any auth step: the procedure body ran and answered with a non-refusal outcome
 * that depends on services this file does not configure. Pinned: the limiter calls, and that
 * the code is NOT one of `REFUSAL_CODES`.
 */
const PASSED = (limiter: string[]): Expect => ({ kind: 'passed', limiter });
const REFUSAL_CODES = ['UNAUTHORIZED', 'FORBIDDEN', 'TOO_MANY_REQUESTS', 'SERVICE_UNAVAILABLE'];

/**
 * THE TABLE: procedure → cell → expected. Generated once from an observation run at the base
 * commit, frozen here as literals, and edited by hand from now on.
 *
 * Reading guide (the per-procedure differences a consolidation must not silently erase):
 *   - `garbage` / `revoked` / `not approved` are the RESOLVER's answers and are uniform per
 *     router — except `apps.storage.*` under `flag off`, where the procedure-level
 *     `enforceAppBlocksFlag` (evaluated on the SESSION user) answers before the resolver.
 *   - `missing scope`: every bridge proc that checks a scope says `block lacks <scope> scope`;
 *     `getImagesByIds` checks none and resolves; `updateUserSettings` checks none and is refused
 *     by the authoring capability instead. Storage and shared use their own message templates
 *     (`getCounts` reuses the `getCount` op name).
 *   - `flag off`: most bridge procs refuse `Apps are not enabled` (the token-subject gate);
 *     `estimateWorkflowBatch` has no flag gate and resolves. Shared answers
 *     `shared storage is not enabled`.
 *   - LIMITER ORDER: `estimateWorkflow`, `estimateWorkflowBatch` and `getImagesByIds` charge
 *     the catalog bucket BEFORE the anonymous-viewer refusal, and `estimateWorkflow` and
 *     `getImagesByIds` also before the flag gate — so those refusals still carry a limiter call.
 *     No other refusal in this table charges a bucket.
 *   - `rate limited`: `pollWorkflow` and `cancelWorkflow` RESOLVE (a non-terminal snapshot, by
 *     design) instead of throwing TOO_MANY_REQUESTS. No limiter call is observed on ANY cell of
 *     `listMyWorkflows`, `submitWorkflow` (whose fixture stops at its model-version lookup),
 *     `updateUserSettings`, the five `apps.storage.*` procedures or the four `apps.shared.*`
 *     reads.
 */
const EXPECTED: Record<string, Record<CellName, Expect>> = {
  'blocks.cancelAppWorkflow': {
    'valid token': E('FORBIDDEN', 'workflow is not in this app subqueue', [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', []),
    'anonymous subject': E('UNAUTHORIZED', 'workflow cancel requires authenticated viewer', []),
    'flag off': E('UNAUTHORIZED', 'Apps are not enabled', []),
    'rate limited': E('TOO_MANY_REQUESTS', 'Rate limit exceeded, please retry shortly.', [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
  },
  'blocks.cancelWorkflow': {
    'valid token': PASSED(['checkBlockCatalogRateLimit("bki_char")']),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', []),
    'anonymous subject': E('UNAUTHORIZED', 'workflow cancel requires authenticated viewer', []),
    'flag off': E('UNAUTHORIZED', 'Apps are not enabled', []),
    'rate limited': OK(['checkBlockCatalogRateLimit("bki_char")']),
  },
  'blocks.consentQuoteGrant': {
    'valid token': PASSED(['checkBlockCatalogRateLimit("bki_char")']),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', []),
    'anonymous subject': E('UNAUTHORIZED', 'training requires an authenticated viewer', []),
    'flag off': E('UNAUTHORIZED', 'Apps are not enabled', []),
    'rate limited': E('TOO_MANY_REQUESTS', 'Rate limit exceeded, please retry shortly.', [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
  },
  'blocks.consentTrainingQuote': {
    'valid token': PASSED(['checkBlockCatalogRateLimit("bki_char")']),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', []),
    'anonymous subject': E('UNAUTHORIZED', 'training requires an authenticated viewer', []),
    'flag off': E('UNAUTHORIZED', 'Apps are not enabled', []),
    'rate limited': E('TOO_MANY_REQUESTS', 'Rate limit exceeded, please retry shortly.', [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
  },
  'blocks.createPostFromApp': {
    'valid token': PASSED([
      'checkBlockPostRateLimit("bki_char", 42)',
      'checkBlockPostAppRateLimit("app_char")',
    ]),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'block lacks posts:write:self scope', []),
    'anonymous subject': E('UNAUTHORIZED', 'posting requires an authenticated viewer', []),
    'flag off': E('UNAUTHORIZED', 'Apps are not enabled', []),
    'rate limited': E('TOO_MANY_REQUESTS', 'Rate limit exceeded, please retry shortly.', [
      'checkBlockPostRateLimit("bki_char", 42)',
    ]),
  },
  'blocks.estimateWorkflow': {
    'valid token': PASSED(['checkBlockCatalogRateLimit("bki_char")']),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', []),
    'anonymous subject': E('UNAUTHORIZED', 'estimate requires authenticated viewer', [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'flag off': E('UNAUTHORIZED', 'Apps are not enabled', [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'rate limited': E('TOO_MANY_REQUESTS', 'Rate limit exceeded, please retry shortly.', [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
  },
  'blocks.estimateWorkflowBatch': {
    'valid token': OK([
      'checkBlockCatalogRateLimit("bki_char")',
      'checkBlockEstimateCellsRateLimit("bki_char", 1)',
    ]),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', []),
    'anonymous subject': E('UNAUTHORIZED', 'estimate requires authenticated viewer', [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'flag off': OK([
      'checkBlockCatalogRateLimit("bki_char")',
      'checkBlockEstimateCellsRateLimit("bki_char", 1)',
    ]),
    'rate limited': E('TOO_MANY_REQUESTS', 'Rate limit exceeded, please retry shortly.', [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
  },
  'blocks.getImagesByIds': {
    'valid token': OK(['checkBlockCatalogRateLimit("bki_char")']),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': OK(['checkBlockCatalogRateLimit("bki_char")']),
    'anonymous subject': E('UNAUTHORIZED', 'gated image read requires an authenticated viewer', [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'flag off': E('UNAUTHORIZED', 'Apps are not enabled', [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'rate limited': E('TOO_MANY_REQUESTS', 'Rate limit exceeded, please retry shortly.', [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
  },
  'blocks.getMyBuzzAccounts': {
    'valid token': PASSED(['checkBlockCatalogRateLimit("bki_char")']),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'block lacks buzz:read:self scope', []),
    'anonymous subject': E('UNAUTHORIZED', 'buzz read requires an authenticated viewer', []),
    'flag off': E('UNAUTHORIZED', 'Apps are not enabled', []),
    'rate limited': E('TOO_MANY_REQUESTS', 'Rate limit exceeded, please retry shortly.', [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
  },
  'blocks.getMyBuzzBalance': {
    'valid token': PASSED(['checkBlockCatalogRateLimit("bki_char")']),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'block lacks buzz:read:self scope', []),
    'anonymous subject': E('UNAUTHORIZED', 'buzz balance requires an authenticated viewer', []),
    'flag off': E('UNAUTHORIZED', 'Apps are not enabled', []),
    'rate limited': E('TOO_MANY_REQUESTS', 'Rate limit exceeded, please retry shortly.', [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
  },
  'blocks.getMyBuzzTransactions': {
    'valid token': PASSED(['checkBlockCatalogRateLimit("bki_char")']),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'block lacks buzz:read:self scope', []),
    'anonymous subject': E('UNAUTHORIZED', 'buzz read requires an authenticated viewer', []),
    'flag off': E('UNAUTHORIZED', 'Apps are not enabled', []),
    'rate limited': E('TOO_MANY_REQUESTS', 'Rate limit exceeded, please retry shortly.', [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
  },
  'blocks.getMyDailyCompensation': {
    'valid token': OK(['checkBlockCatalogRateLimit("bki_char")']),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'block lacks buzz:read:self scope', []),
    'anonymous subject': E('UNAUTHORIZED', 'buzz read requires an authenticated viewer', []),
    'flag off': E('UNAUTHORIZED', 'Apps are not enabled', []),
    'rate limited': E('TOO_MANY_REQUESTS', 'Rate limit exceeded, please retry shortly.', [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
  },
  'blocks.getMyViewer': {
    'valid token': OK(['checkBlockCatalogRateLimit("bki_char")']),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'block lacks user:read:self scope', []),
    'anonymous subject': E('UNAUTHORIZED', 'viewer read requires an authenticated viewer', []),
    'flag off': E('UNAUTHORIZED', 'Apps are not enabled', []),
    'rate limited': E('TOO_MANY_REQUESTS', 'Rate limit exceeded, please retry shortly.', [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
  },
  'blocks.listMyWorkflows': {
    'valid token': OK([]),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', []),
    'anonymous subject': E('UNAUTHORIZED', 'workflow list requires authenticated viewer', []),
    'flag off': E('UNAUTHORIZED', 'Apps are not enabled', []),
    'rate limited': OK([]),
  },
  'blocks.persistAppUploadImage': {
    'valid token': PASSED(['checkBlockPublishRateLimit("bki_char", 1)']),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'block lacks posts:write:self scope', []),
    'anonymous subject': E('UNAUTHORIZED', 'posting requires an authenticated viewer', []),
    'flag off': E('UNAUTHORIZED', 'Apps are not enabled', []),
    'rate limited': E('TOO_MANY_REQUESTS', 'Rate limit exceeded, please retry shortly.', [
      'checkBlockPublishRateLimit("bki_char", 1)',
    ]),
  },
  'blocks.pollWorkflow': {
    'valid token': PASSED(['checkBlockPollRateLimit("bki_char", 42)']),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', []),
    'anonymous subject': E('UNAUTHORIZED', 'workflow poll requires authenticated viewer', []),
    'flag off': E('UNAUTHORIZED', 'Apps are not enabled', []),
    'rate limited': OK(['checkBlockPollRateLimit("bki_char", 42)']),
  },
  'blocks.prepareTrainingDataset': {
    'valid token': PASSED(['checkBlockTrainingDatasetRateLimit("bki_char", 42, 1)']),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', []),
    'anonymous subject': E('UNAUTHORIZED', 'training requires an authenticated viewer', []),
    'flag off': E('UNAUTHORIZED', 'Apps are not enabled', []),
    'rate limited': E('TOO_MANY_REQUESTS', 'Rate limit exceeded, please retry shortly.', [
      'checkBlockTrainingDatasetRateLimit("bki_char", 42, 1)',
    ]),
  },
  'blocks.previewPostFromApp': {
    'valid token': PASSED(['checkBlockCatalogRateLimit("bki_char")']),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'block lacks posts:write:self scope', []),
    'anonymous subject': E('UNAUTHORIZED', 'posting requires an authenticated viewer', []),
    'flag off': E('UNAUTHORIZED', 'Apps are not enabled', []),
    'rate limited': E('TOO_MANY_REQUESTS', 'Rate limit exceeded, please retry shortly.', [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
  },
  'blocks.previewQuoteGrant': {
    'valid token': PASSED(['checkBlockCatalogRateLimit("bki_char")']),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', []),
    'anonymous subject': E('UNAUTHORIZED', 'training requires an authenticated viewer', []),
    'flag off': E('UNAUTHORIZED', 'Apps are not enabled', []),
    'rate limited': E('TOO_MANY_REQUESTS', 'Rate limit exceeded, please retry shortly.', [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
  },
  'blocks.previewTrainingQuote': {
    'valid token': PASSED(['checkBlockCatalogRateLimit("bki_char")']),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', []),
    'anonymous subject': E('UNAUTHORIZED', 'training requires an authenticated viewer', []),
    'flag off': E('UNAUTHORIZED', 'Apps are not enabled', []),
    'rate limited': E('TOO_MANY_REQUESTS', 'Rate limit exceeded, please retry shortly.', [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
  },
  'blocks.publishGenerationOutputs': {
    'valid token': E('FORBIDDEN', 'workflow is not in this app subqueue', [
      'checkBlockPublishRateLimit("bki_char", 1)',
    ]),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', []),
    'anonymous subject': E('UNAUTHORIZED', 'publishing requires an authenticated viewer', []),
    'flag off': E('UNAUTHORIZED', 'Apps are not enabled', []),
    'rate limited': E('TOO_MANY_REQUESTS', 'Rate limit exceeded, please retry shortly.', [
      'checkBlockPublishRateLimit("bki_char", 1)',
    ]),
  },
  'blocks.queryAppWorkflows': {
    'valid token': PASSED(['checkBlockCatalogRateLimit("bki_char")']),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', []),
    'anonymous subject': E('UNAUTHORIZED', 'workflow query requires authenticated viewer', []),
    'flag off': E('UNAUTHORIZED', 'Apps are not enabled', []),
    'rate limited': E('TOO_MANY_REQUESTS', 'Rate limit exceeded, please retry shortly.', [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
  },
  'blocks.submitWorkflow': {
    'valid token': PASSED([]),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', []),
    'anonymous subject': E('UNAUTHORIZED', 'workflow submit requires authenticated viewer', []),
    'flag off': E('UNAUTHORIZED', 'Apps are not enabled', []),
    'rate limited': PASSED([]),
  },
  'blocks.updateUserSettings': {
    'valid token': E('FORBIDDEN', 'Apps authoring is not enabled for this account', []),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'Apps authoring is not enabled for this account', []),
    'anonymous subject': E('UNAUTHORIZED', 'anon viewers cannot persist block settings', []),
    'flag off': E('UNAUTHORIZED', 'Apps are not enabled', []),
    'rate limited': E('FORBIDDEN', 'Apps authoring is not enabled for this account', []),
  },
  'apps.storage.get': {
    'valid token': PASSED([]),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'storage get requires the apps:storage:read scope', []),
    'anonymous subject': OK([]),
    'flag off': E('UNAUTHORIZED', 'Apps access is not enabled for this browser session', []),
    'rate limited': PASSED([]),
  },
  'apps.storage.set': {
    'valid token': PASSED([]),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'storage set requires the apps:storage:write scope', []),
    'anonymous subject': E('UNAUTHORIZED', 'storage requires an authenticated viewer', []),
    'flag off': E('UNAUTHORIZED', 'Apps access is not enabled for this browser session', []),
    'rate limited': PASSED([]),
  },
  'apps.storage.delete': {
    'valid token': PASSED([]),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'storage delete requires the apps:storage:write scope', []),
    'anonymous subject': E('UNAUTHORIZED', 'storage requires an authenticated viewer', []),
    'flag off': E('UNAUTHORIZED', 'Apps access is not enabled for this browser session', []),
    'rate limited': PASSED([]),
  },
  'apps.storage.list': {
    'valid token': PASSED([]),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'storage list requires the apps:storage:read scope', []),
    'anonymous subject': OK([]),
    'flag off': E('UNAUTHORIZED', 'Apps access is not enabled for this browser session', []),
    'rate limited': PASSED([]),
  },
  'apps.storage.getQuota': {
    'valid token': PASSED([]),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E('FORBIDDEN', 'storage getQuota requires the apps:storage:read scope', []),
    'anonymous subject': OK([]),
    'flag off': E('UNAUTHORIZED', 'Apps access is not enabled for this browser session', []),
    'rate limited': PASSED([]),
  },
  'apps.shared.list': {
    'valid token': PASSED([]),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E(
      'FORBIDDEN',
      'shared storage list requires the apps:storage:shared:read scope',
      []
    ),
    'anonymous subject': PASSED([]),
    'flag off': E('FORBIDDEN', 'shared storage is not enabled', []),
    'rate limited': PASSED([]),
  },
  'apps.shared.get': {
    'valid token': PASSED([]),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E(
      'FORBIDDEN',
      'shared storage get requires the apps:storage:shared:read scope',
      []
    ),
    'anonymous subject': PASSED([]),
    'flag off': E('FORBIDDEN', 'shared storage is not enabled', []),
    'rate limited': PASSED([]),
  },
  'apps.shared.getCount': {
    'valid token': PASSED([]),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E(
      'FORBIDDEN',
      'shared storage getCount requires the apps:storage:shared:read scope',
      []
    ),
    'anonymous subject': PASSED([]),
    'flag off': E('FORBIDDEN', 'shared storage is not enabled', []),
    'rate limited': PASSED([]),
  },
  'apps.shared.getCounts': {
    'valid token': PASSED([]),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E(
      'FORBIDDEN',
      'shared storage getCount requires the apps:storage:shared:read scope',
      []
    ),
    'anonymous subject': PASSED([]),
    'flag off': E('FORBIDDEN', 'shared storage is not enabled', []),
    'rate limited': PASSED([]),
  },
  'apps.shared.append': {
    'valid token': PASSED(['reserveSharedWrite(42, "apb_char")']),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E(
      'FORBIDDEN',
      'shared storage append requires the apps:storage:shared:write scope',
      []
    ),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'shared storage writes require an authenticated viewer',
      []
    ),
    'flag off': E('FORBIDDEN', 'shared storage is not enabled', []),
    'rate limited': E('TOO_MANY_REQUESTS', 'Too many submissions — retry in 7s', [
      'reserveSharedWrite(42, "apb_char")',
    ]),
  },
  'apps.shared.update': {
    'valid token': PASSED(['reserveSharedWrite(42, "apb_char")']),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E(
      'FORBIDDEN',
      'shared storage update requires the apps:storage:shared:write scope',
      []
    ),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'shared storage writes require an authenticated viewer',
      []
    ),
    'flag off': E('FORBIDDEN', 'shared storage is not enabled', []),
    'rate limited': E('TOO_MANY_REQUESTS', 'Too many submissions — retry in 7s', [
      'reserveSharedWrite(42, "apb_char")',
    ]),
  },
  'apps.shared.vote': {
    'valid token': PASSED(['checkSharedVoteRateLimit(42, "apb_char")']),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E(
      'FORBIDDEN',
      'shared storage vote requires the apps:storage:shared:write scope',
      []
    ),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'shared storage writes require an authenticated viewer',
      []
    ),
    'flag off': E('FORBIDDEN', 'shared storage is not enabled', []),
    'rate limited': E('TOO_MANY_REQUESTS', 'Too many votes — retry in 7s', [
      'checkSharedVoteRateLimit(42, "apb_char")',
    ]),
  },
  'apps.shared.unvote': {
    'valid token': PASSED(['checkSharedVoteRateLimit(42, "apb_char")']),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E(
      'FORBIDDEN',
      'shared storage unvote requires the apps:storage:shared:write scope',
      []
    ),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'shared storage writes require an authenticated viewer',
      []
    ),
    'flag off': E('FORBIDDEN', 'shared storage is not enabled', []),
    'rate limited': E('TOO_MANY_REQUESTS', 'Too many votes — retry in 7s', [
      'checkSharedVoteRateLimit(42, "apb_char")',
    ]),
  },
  'apps.shared.withdraw': {
    'valid token': PASSED(['checkSharedWithdrawRateLimit(42, "apb_char")']),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E(
      'FORBIDDEN',
      'shared storage withdraw requires the apps:storage:shared:write scope',
      []
    ),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'shared storage writes require an authenticated viewer',
      []
    ),
    'flag off': E('FORBIDDEN', 'shared storage is not enabled', []),
    'rate limited': E('TOO_MANY_REQUESTS', 'Too many withdrawals — retry in 7s', [
      'checkSharedWithdrawRateLimit(42, "apb_char")',
    ]),
  },
  'apps.shared.report': {
    'valid token': PASSED(['checkSharedReportRateLimit(42, "apb_char")']),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', []),
    revoked: E('FORBIDDEN', 'block instance revoked', []),
    'not approved': E('FORBIDDEN', 'app block is not approved', []),
    'missing scope': E(
      'FORBIDDEN',
      'shared storage report requires the apps:storage:shared:write scope',
      []
    ),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'shared storage writes require an authenticated viewer',
      []
    ),
    'flag off': E('FORBIDDEN', 'shared storage is not enabled', []),
    'rate limited': E('TOO_MANY_REQUESTS', 'Too many reports — retry in 7s', [
      'checkSharedReportRateLimit(42, "apb_char")',
    ]),
  },
};

describe('block-token tRPC procedures — characterisation table', () => {
  it('covers EXACTLY the procedures whose input declares a blockToken', () => {
    const derived = [
      ...blockTokenProcedures('blocks', blocksRouter),
      ...blockTokenProcedures('apps', appsRouter),
    ].sort();
    // Positive control on the derivation: it must find a known bridge proc AND a known
    // storage proc, so a walker that matched nothing cannot read as full coverage.
    expect(derived).toContain('blocks.getMyBuzzBalance');
    expect(derived).toContain('apps.storage.get');
    expect(derived).toEqual(Object.keys(INPUTS).sort());
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(INPUTS).sort());
  });

  it('every procedure row has exactly one expectation per cell', () => {
    for (const [path, cells] of Object.entries(EXPECTED)) {
      expect(Object.keys(cells).sort(), path).toEqual(Object.keys(CELLS).sort());
    }
  });

  for (const path of Object.keys(INPUTS)) {
    for (const cell of Object.keys(CELLS) as CellName[]) {
      it(`${path} — ${cell}`, async () => {
        const want = EXPECTED[path]?.[cell];
        expect(want, 'no expectation for this cell').toBeDefined();
        currentPath = path;
        const got = await CELLS[cell](path);
        expect(got.limiter, 'rate-limiter calls (name + bucket arguments, in order)').toEqual(
          want.limiter
        );
        if (want.kind === 'ok') {
          expect(got.result).toEqual({ ok: true });
        } else if (want.kind === 'error') {
          expect(got.result).toEqual({
            error: 'TRPCError',
            code: want.code,
            message: want.message,
          });
        } else {
          const r = got.result as { code?: string; message?: string };
          expect(REFUSAL_CODES, `refused: ${r.code} ${r.message}`).not.toContain(r.code);
        }
      });
    }
  }
});
