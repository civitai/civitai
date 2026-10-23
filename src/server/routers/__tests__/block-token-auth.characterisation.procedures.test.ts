import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Setup-order import: shared db/redis/env/prom mocks and the REAL test RSA keypair, so the
// tokens below are really signed and the procedures really verify them.
import '~/__tests__/setup';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';
import type * as ConsentRevocationModule from '~/server/services/blocks/consent-revocation.service';
import type * as DevTunnelModule from '~/server/services/blocks/dev-tunnel.service';
import type * as CatalogRateLimit from '~/server/utils/block-catalog-rate-limit';
import type * as SharedRateLimit from '~/server/utils/shared-storage-rate-limit';
import type * as BridgeAuth from '~/server/services/blocks/block-bridge-auth.service';
import type * as TokenAccess from '~/server/services/blocks/block-token-access.service';

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
 * on services this file does not set up. Every cell records `reached` — the positive anchors it
 * passed (bridge resolver resolved/threw, token-subject gate resolved/threw for WHICH user id,
 * every session hydration by the user id asked for, apps-db pool reached). Storage and shared calls that get past their resolver stop at an
 * apps-db sentinel and are pinned verbatim. The remaining non-refusals are PASSED: limiter calls
 * and `reached` pinned, and the code must not be a refusal code. Refusals are pinned verbatim.
 */

const h = vi.hoisted(() => ({
  isRevoked: vi.fn(),
  consentLookup: vi.fn(),
  getActiveDevTunnel: vi.fn(),
  getSessionUserById: vi.fn(),
  runFlag: { on: true },
  limiter: { deny: false },
  limiterCalls: [] as string[],
  reached: [] as string[],
  flagBase: { on: false },
  sessionUserId: { id: 7 },
  sessionFlag: { on: false },
}));

/**
 * Flags are evaluated FOR SOMEONE, so the mocks answer per user: every flag is on for the token
 * subject (42) only — never for the session user (7) — and a no-user (global) evaluation gets the
 * base value, off.
 * An evaluation handed the wrong identity — or none — therefore answers differently.
 */
function flagFor(ids: () => number[]) {
  return async (opts?: { user?: { id?: number } }) =>
    opts?.user ? opts.user.id != null && ids().includes(opts.user.id) : h.flagBase.on;
}

vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof AppBlocksFlag>()),
  // On for the session user (7) too ONLY in the session-flag-on cell.
  isAppBlocksEnabled: flagFor(() => (h.runFlag.on ? (h.sessionFlag.on ? [42, 7] : [42]) : [])),
  isAppBlocksSharedStorageEnabled: flagFor(() => (h.runFlag.on ? [42] : [])),
  isAppBlocksAuthorEnabled: async () => false,
  isAppBlocksPostCreationEnabled: flagFor(() => (h.runFlag.on ? [42] : [])),
  isAppBlocksTrainingKindEnabled: flagFor(() => (h.runFlag.on ? [42] : [])),
  isAppBlocksConfirmedStepEnabled: flagFor(() => (h.runFlag.on ? [42] : [])),
  isAppBlocksAppReactionsEnabled: flagFor(() => (h.runFlag.on ? [42] : [])),
}));
/**
 * POSITIVE ANCHORS. A cell that is not refused must say how far it got, not only what it did
 * not answer. These pass-through spies record whether the bridge resolver and the token-subject
 * gate RESOLVED or THREW, and the apps-db pool is replaced by a sentinel that records the visit
 * and stops there — so a storage/shared call that got past its resolver reads
 * `PAST_AUTH: reached the apps-db pool` rather than whatever an unconfigured database says.
 */
vi.mock('~/server/services/blocks/block-bridge-auth.service', async (importOriginal) => {
  const real = await importOriginal<typeof BridgeAuth>();
  return {
    ...real,
    authorizeBlockBridgeToken: async (t: string) => {
      try {
        const out = await real.authorizeBlockBridgeToken(t);
        h.reached.push('bridge-auth:ok');
        return out;
      } catch (err) {
        h.reached.push('bridge-auth:threw');
        throw err;
      }
    },
  };
});
vi.mock('~/server/services/blocks/block-token-access.service', async (importOriginal) => {
  const real = await importOriginal<typeof TokenAccess>();
  return {
    ...real,
    assertAppBlocksEnabledForTokenUser: async (userId: number) => {
      try {
        await real.assertAppBlocksEnabledForTokenUser(userId);
        h.reached.push(`subject-gate:ok:${userId}`);
      } catch (err) {
        h.reached.push(`subject-gate:threw:${userId}`);
        throw err;
      }
    },
  };
});
vi.mock('~/server/db/appsDb', () => ({
  requireAppsDb: () => {
    h.reached.push('apps-db');
    throw new Error('PAST_AUTH: reached the apps-db pool');
  },
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
const SESSION_USER_ID = 7;
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
  'social:react:self',
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
  'blocks.previewTrainingQuote',
  'blocks.consentTrainingQuote',
  'blocks.previewQuoteGrant',
  'blocks.consentQuoteGrant',
]);
let currentPath = '';

/**
 * Procedures that require the signed-in SESSION to be the token subject. Their ordinary cells
 * run with session = subject (otherwise every cell stops at that one refusal); the two
 * `session user is not the token subject` cells pin the refusal itself, on every procedure.
 */
const SESSION_BOUND = new Set([
  'blocks.consentQuoteGrant',
  'blocks.consentTrainingQuote',
  'blocks.createPostFromApp',
  'blocks.getReactionsForApp',
  'blocks.persistAppUploadImage',
  'blocks.previewPostFromApp',
  'blocks.previewQuoteGrant',
  'blocks.previewTrainingQuote',
  'blocks.publishGenerationOutputs',
  'blocks.setReactionFromApp',
]);

async function mint(over: { scopes?: string[]; anon?: boolean } = {}) {
  const { token } = await BlockTokenService.sign({
    userId: over.anon ? null : SUBJECT_ID,
    blockId: 'char-block',
    appId: 'app_char',
    appBlockId: 'apb_claim',
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
  // No tickets: the read answers the id as `unavailable` rather than refusing the call.
  'blocks.getReactionsForApp': { entityType: 'image', ids: [1] },
  'blocks.listMyWorkflows': {},
  'blocks.persistAppUploadImage': { url: '00000000-0000-4000-8000-000000000000' },
  'blocks.pollWorkflow': { workflowId: 'wf_1' },
  'blocks.previewPostFromApp': POST_PAYLOAD,
  'blocks.previewQuoteGrant': { kind: 'training', quoteId: QUOTE_ID },
  'blocks.previewTrainingQuote': { quoteId: QUOTE_ID },
  'blocks.publishGenerationOutputs': { workflowId: 'wf_1' },
  'blocks.queryAppWorkflows': {},
  // No ticket, so a token that passes every auth step stops at the provenance guard.
  'blocks.setReactionFromApp': {
    entityType: 'image',
    entityId: 1,
    reaction: 'Heart',
    reacted: true,
  },
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
    // The SESSION user is a different person from the token subject (42), so every limiter key
    // and flag evaluation in the table says WHICH identity it used.
    user: { ...SUBJECT, id: h.sessionUserId.id },
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
  /** The positive anchors this call passed through, in order (see the spies above). */
  reached: string[];
};

async function invoke(path: string, token: string): Promise<Outcome> {
  h.limiterCalls.length = 0;
  h.reached.length = 0;
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
  return { result, limiter: [...h.limiterCalls], reached: [...h.reached] };
}

// ── population, derived from the routers themselves ──────────────────────────────────────

/** Does this zod schema (or anything it wraps) declare a `blockToken` key? */
function hasBlockTokenKey(schema: unknown, depth = 0): boolean {
  if (!schema || typeof schema !== 'object' || depth > 8) return false;
  const s = schema as {
    shape?: Record<string, unknown>;
    options?: unknown[];
    def?: {
      innerType?: unknown;
      in?: unknown;
      schema?: unknown;
      options?: unknown[];
      left?: unknown;
      right?: unknown;
    };
    _def?: { innerType?: unknown; schema?: unknown };
  };
  if (s.shape && typeof s.shape === 'object' && 'blockToken' in s.shape) return true;
  const kids = [
    ...(Array.isArray(s.options) ? s.options : []),
    ...(Array.isArray(s.def?.options) ? s.def!.options! : []),
    s.def?.innerType,
    s.def?.in,
    s.def?.schema,
    // Intersections (`a.and(b)`): either side may carry the token.
    s.def?.left,
    s.def?.right,
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
  h.flagBase.on = false;
  h.sessionUserId.id = SESSION_USER_ID;
  h.sessionFlag.on = false;
  h.limiter.deny = false;
  h.limiterCalls.length = 0;
  h.isRevoked.mockReset().mockResolvedValue(false);
  h.consentLookup.mockReset().mockResolvedValue({ kind: 'none' });
  h.getActiveDevTunnel.mockReset().mockResolvedValue(null);
  // Answers only for the id asked for, and records it: the subject (42) and the session user (7)
  // exist, any other id is unknown.
  h.getSessionUserById.mockReset().mockImplementation(async (id: number) => {
    h.reached.push(`hydrate:${id}`);
    if (id === SUBJECT_ID) return { ...SUBJECT };
    if (id === SESSION_USER_ID) return { ...SUBJECT, id: SESSION_USER_ID };
    return null;
  });
  dbMock.dbRead.appBlock.findUnique.mockReset().mockResolvedValue({
    id: 'apb_row',
    status: 'approved',
  });
  dbMock.dbRead.oauthClient.findUnique.mockReset().mockResolvedValue({ userId: SUBJECT_ID });
  // A user row for whichever id is asked for, for the procedures that look a viewer up.
  const userRow = async (args?: { where?: { id?: number } }) => ({
    ...SUBJECT,
    id: args?.where?.id ?? SUBJECT_ID,
    deletedAt: null,
  });
  dbMock.dbRead.user.findUnique.mockReset().mockImplementation(userRow);
  dbMock.dbWrite.user.findUnique.mockReset().mockImplementation(userRow);
});

type CellName =
  | 'valid token'
  | 'garbage token'
  | 'revoked'
  | 'not approved'
  | 'missing scope'
  | 'anonymous subject'
  | 'flag off'
  | 'rate limited'
  | "session user is not the token subject (session user's run flag off)"
  | "session user is not the token subject (session user's run flag on)";

const CELLS: Record<CellName, (path: string) => Promise<Outcome>> = {
  'valid token': async (p) => invoke(p, await mint()),
  'garbage token': (p) => invoke(p, 'not-a-jwt'),
  revoked: async (p) => {
    h.isRevoked.mockResolvedValue(true);
    return invoke(p, await mint());
  },
  'not approved': async (p) => {
    dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ id: 'apb_row', status: 'suspended' });
    return invoke(p, await mint());
  },
  'missing scope': async (p) => invoke(p, await mint({ scopes: [] })),
  // Flags base-enabled (the GA shape), so a no-user flag evaluation for an anon subject admits
  // it and the cell pins each procedure's OWN anonymous-viewer handling.
  'anonymous subject': async (p) => {
    h.flagBase.on = true;
    return invoke(p, await mint({ anon: true }));
  },
  'flag off': async (p) => {
    h.runFlag.on = false;
    return invoke(p, await mint());
  },
  'rate limited': async (p) => {
    h.limiter.deny = true;
    return invoke(p, await mint());
  },
  "session user is not the token subject (session user's run flag off)": async (p) => {
    h.sessionUserId.id = SESSION_USER_ID;
    return invoke(p, await mint());
  }, // The session user HAS the run flag, and the token belongs to a different subject.
  "session user is not the token subject (session user's run flag on)": async (p) => {
    h.sessionUserId.id = SESSION_USER_ID;
    h.sessionFlag.on = true;
    return invoke(p, await mint());
  },
};

// ── expectations ─────────────────────────────────────────────────────────────────────────

type Expect =
  | { kind: 'ok'; limiter: string[]; reached: string[] }
  | { kind: 'error'; code: string; message: string; limiter: string[]; reached: string[] }
  | { kind: 'passed'; limiter: string[]; reached: string[] };

/** Resolved. */
const OK = (limiter: string[], reached: string[]): Expect => ({ kind: 'ok', limiter, reached });
/** Threw exactly this TRPCError code and message. */
const E = (code: string, message: string, limiter: string[], reached: string[]): Expect => ({
  kind: 'error',
  code,
  message,
  limiter,
  reached,
});
/**
 * Not refused by any auth step: the procedure body ran past them and answered with an outcome
 * that depends on services this file does not configure (a missing model version, a network
 * call, an unstubbed client export). Pinned POSITIVELY by `reached` — the bridge resolver and
 * the token-subject gate resolved, for the identity named — plus the limiter calls, and
 * negatively by the code not being one of `REFUSAL_CODES`.
 */
const PASSED = (limiter: string[], reached: string[]): Expect => ({
  kind: 'passed',
  limiter,
  reached,
});
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
 *   - IDENTITIES ARE DISTINCT ON PURPOSE: session user 7, token subject 42, approval row
 *     `apb_row`, token claim `apb_claim`. So the shared-storage buckets are visibly keyed on
 *     (subject, ROW id), the bridge buckets on the token's instance id (and subject), and
 *     `subject-gate:ok:42` shows the run-flag gate evaluated the SUBJECT, not the session.
 *   - SESSION USER 7, TOKEN SUBJECT 42, in two cells that differ only in whether user 7 has the
 *     run flag:
 *       - the eight SESSION_BOUND bridge procedures refuse `this app session belongs to a
 *         different account` in both, right after the bridge resolver;
 *       - the five `apps.storage.*` procedures refuse `Apps access is not enabled for this
 *         browser session` when user 7's flag is off, and when it is on they proceed AS THE
 *         TOKEN SUBJECT (`hydrate:42`, apps-db reached): their procedure gate evaluates the
 *         session user's flag and does not compare it with the subject;
 *       - the other 26 procedures answer identically in both cells, the same as `valid token`.
 *   - `anonymous subject` runs with flags base-enabled (the GA shape), so it pins each
 *     procedure's own anonymous handling rather than the flag.
 */
const EXPECTED: Record<string, Record<CellName, Expect>> = {
  'blocks.cancelAppWorkflow': {
    'valid token': E(
      'FORBIDDEN',
      'workflow is not in this app subqueue',
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], ['bridge-auth:threw']),
    revoked: E('FORBIDDEN', 'block instance revoked', [], ['bridge-auth:threw']),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], ['bridge-auth:threw']),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', [], ['bridge-auth:ok']),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'workflow cancel requires authenticated viewer',
      [],
      ['bridge-auth:ok']
    ),
    'flag off': E(
      'UNAUTHORIZED',
      'Apps are not enabled',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:threw:42']
    ),
    'rate limited': E(
      'TOO_MANY_REQUESTS',
      'Rate limit exceeded, please retry shortly.',
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'FORBIDDEN',
      'workflow is not in this app subqueue',
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'FORBIDDEN',
      'workflow is not in this app subqueue',
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
  },
  'blocks.cancelWorkflow': {
    'valid token': PASSED(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], ['bridge-auth:threw']),
    revoked: E('FORBIDDEN', 'block instance revoked', [], ['bridge-auth:threw']),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], ['bridge-auth:threw']),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', [], ['bridge-auth:ok']),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'workflow cancel requires authenticated viewer',
      [],
      ['bridge-auth:ok']
    ),
    'flag off': E(
      'UNAUTHORIZED',
      'Apps are not enabled',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:threw:42']
    ),
    'rate limited': OK(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag off)": PASSED(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag on)": PASSED(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
  },
  'blocks.consentQuoteGrant': {
    'valid token': PASSED(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], ['bridge-auth:threw']),
    revoked: E('FORBIDDEN', 'block instance revoked', [], ['bridge-auth:threw']),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], ['bridge-auth:threw']),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', [], ['bridge-auth:ok']),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'training requires an authenticated viewer',
      [],
      ['bridge-auth:ok']
    ),
    'flag off': E(
      'UNAUTHORIZED',
      'Apps are not enabled',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:threw:42']
    ),
    'rate limited': E(
      'TOO_MANY_REQUESTS',
      'Rate limit exceeded, please retry shortly.',
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'FORBIDDEN',
      'this app session belongs to a different account; reload the page to continue',
      [],
      ['bridge-auth:ok']
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'FORBIDDEN',
      'this app session belongs to a different account; reload the page to continue',
      [],
      ['bridge-auth:ok']
    ),
  },
  'blocks.consentTrainingQuote': {
    'valid token': PASSED(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], ['bridge-auth:threw']),
    revoked: E('FORBIDDEN', 'block instance revoked', [], ['bridge-auth:threw']),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], ['bridge-auth:threw']),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', [], ['bridge-auth:ok']),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'training requires an authenticated viewer',
      [],
      ['bridge-auth:ok']
    ),
    'flag off': E(
      'UNAUTHORIZED',
      'Apps are not enabled',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:threw:42']
    ),
    'rate limited': E(
      'TOO_MANY_REQUESTS',
      'Rate limit exceeded, please retry shortly.',
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'FORBIDDEN',
      'this app session belongs to a different account; reload the page to continue',
      [],
      ['bridge-auth:ok']
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'FORBIDDEN',
      'this app session belongs to a different account; reload the page to continue',
      [],
      ['bridge-auth:ok']
    ),
  },
  'blocks.createPostFromApp': {
    'valid token': PASSED(
      ['checkBlockPostRateLimit("bki_char", 42)', 'checkBlockPostAppRateLimit("app_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42', 'hydrate:42']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], ['bridge-auth:threw']),
    revoked: E('FORBIDDEN', 'block instance revoked', [], ['bridge-auth:threw']),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], ['bridge-auth:threw']),
    'missing scope': E('FORBIDDEN', 'block lacks posts:write:self scope', [], ['bridge-auth:ok']),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'posting requires an authenticated viewer',
      [],
      ['bridge-auth:ok']
    ),
    'flag off': E(
      'UNAUTHORIZED',
      'Apps are not enabled',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:threw:42']
    ),
    'rate limited': E(
      'TOO_MANY_REQUESTS',
      'Rate limit exceeded, please retry shortly.',
      ['checkBlockPostRateLimit("bki_char", 42)'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42', 'hydrate:42']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'FORBIDDEN',
      'this app session belongs to a different account; reload the page to continue',
      [],
      ['bridge-auth:ok']
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'FORBIDDEN',
      'this app session belongs to a different account; reload the page to continue',
      [],
      ['bridge-auth:ok']
    ),
  },
  'blocks.estimateWorkflow': {
    'valid token': PASSED(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], ['bridge-auth:threw']),
    revoked: E('FORBIDDEN', 'block instance revoked', [], ['bridge-auth:threw']),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], ['bridge-auth:threw']),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', [], ['bridge-auth:ok']),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'estimate requires authenticated viewer',
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok']
    ),
    'flag off': E(
      'UNAUTHORIZED',
      'Apps are not enabled',
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:threw:42']
    ),
    'rate limited': E(
      'TOO_MANY_REQUESTS',
      'Rate limit exceeded, please retry shortly.',
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok']
    ),
    "session user is not the token subject (session user's run flag off)": PASSED(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag on)": PASSED(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
  },
  'blocks.estimateWorkflowBatch': {
    'valid token': OK(
      ['checkBlockCatalogRateLimit("bki_char")', 'checkBlockEstimateCellsRateLimit("bki_char", 1)'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], ['bridge-auth:threw']),
    revoked: E('FORBIDDEN', 'block instance revoked', [], ['bridge-auth:threw']),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], ['bridge-auth:threw']),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', [], ['bridge-auth:ok']),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'estimate requires authenticated viewer',
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok']
    ),
    'flag off': OK(
      ['checkBlockCatalogRateLimit("bki_char")', 'checkBlockEstimateCellsRateLimit("bki_char", 1)'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:threw:42']
    ),
    'rate limited': E(
      'TOO_MANY_REQUESTS',
      'Rate limit exceeded, please retry shortly.',
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok']
    ),
    "session user is not the token subject (session user's run flag off)": OK(
      ['checkBlockCatalogRateLimit("bki_char")', 'checkBlockEstimateCellsRateLimit("bki_char", 1)'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag on)": OK(
      ['checkBlockCatalogRateLimit("bki_char")', 'checkBlockEstimateCellsRateLimit("bki_char", 1)'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
  },
  'blocks.getImagesByIds': {
    'valid token': OK(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], ['bridge-auth:threw']),
    revoked: E('FORBIDDEN', 'block instance revoked', [], ['bridge-auth:threw']),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], ['bridge-auth:threw']),
    'missing scope': OK(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'gated image read requires an authenticated viewer',
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok']
    ),
    'flag off': E(
      'UNAUTHORIZED',
      'Apps are not enabled',
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:threw:42']
    ),
    'rate limited': E(
      'TOO_MANY_REQUESTS',
      'Rate limit exceeded, please retry shortly.',
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok']
    ),
    "session user is not the token subject (session user's run flag off)": OK(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag on)": OK(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
  },
  'blocks.getMyBuzzAccounts': {
    'valid token': PASSED(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], ['bridge-auth:threw']),
    revoked: E('FORBIDDEN', 'block instance revoked', [], ['bridge-auth:threw']),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], ['bridge-auth:threw']),
    'missing scope': E('FORBIDDEN', 'block lacks buzz:read:self scope', [], ['bridge-auth:ok']),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'buzz read requires an authenticated viewer',
      [],
      ['bridge-auth:ok']
    ),
    'flag off': E(
      'UNAUTHORIZED',
      'Apps are not enabled',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:threw:42']
    ),
    'rate limited': E(
      'TOO_MANY_REQUESTS',
      'Rate limit exceeded, please retry shortly.',
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag off)": PASSED(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag on)": PASSED(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
  },
  'blocks.getMyBuzzBalance': {
    'valid token': PASSED(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], ['bridge-auth:threw']),
    revoked: E('FORBIDDEN', 'block instance revoked', [], ['bridge-auth:threw']),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], ['bridge-auth:threw']),
    'missing scope': E('FORBIDDEN', 'block lacks buzz:read:self scope', [], ['bridge-auth:ok']),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'buzz balance requires an authenticated viewer',
      [],
      ['bridge-auth:ok']
    ),
    'flag off': E(
      'UNAUTHORIZED',
      'Apps are not enabled',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:threw:42']
    ),
    'rate limited': E(
      'TOO_MANY_REQUESTS',
      'Rate limit exceeded, please retry shortly.',
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag off)": PASSED(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag on)": PASSED(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
  },
  'blocks.getMyBuzzTransactions': {
    'valid token': PASSED(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], ['bridge-auth:threw']),
    revoked: E('FORBIDDEN', 'block instance revoked', [], ['bridge-auth:threw']),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], ['bridge-auth:threw']),
    'missing scope': E('FORBIDDEN', 'block lacks buzz:read:self scope', [], ['bridge-auth:ok']),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'buzz read requires an authenticated viewer',
      [],
      ['bridge-auth:ok']
    ),
    'flag off': E(
      'UNAUTHORIZED',
      'Apps are not enabled',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:threw:42']
    ),
    'rate limited': E(
      'TOO_MANY_REQUESTS',
      'Rate limit exceeded, please retry shortly.',
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag off)": PASSED(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag on)": PASSED(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
  },
  'blocks.getMyDailyCompensation': {
    'valid token': OK(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], ['bridge-auth:threw']),
    revoked: E('FORBIDDEN', 'block instance revoked', [], ['bridge-auth:threw']),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], ['bridge-auth:threw']),
    'missing scope': E('FORBIDDEN', 'block lacks buzz:read:self scope', [], ['bridge-auth:ok']),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'buzz read requires an authenticated viewer',
      [],
      ['bridge-auth:ok']
    ),
    'flag off': E(
      'UNAUTHORIZED',
      'Apps are not enabled',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:threw:42']
    ),
    'rate limited': E(
      'TOO_MANY_REQUESTS',
      'Rate limit exceeded, please retry shortly.',
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag off)": OK(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag on)": OK(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
  },
  'blocks.getMyViewer': {
    'valid token': OK(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], ['bridge-auth:threw']),
    revoked: E('FORBIDDEN', 'block instance revoked', [], ['bridge-auth:threw']),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], ['bridge-auth:threw']),
    'missing scope': E('FORBIDDEN', 'block lacks user:read:self scope', [], ['bridge-auth:ok']),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'viewer read requires an authenticated viewer',
      [],
      ['bridge-auth:ok']
    ),
    'flag off': E(
      'UNAUTHORIZED',
      'Apps are not enabled',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:threw:42']
    ),
    'rate limited': E(
      'TOO_MANY_REQUESTS',
      'Rate limit exceeded, please retry shortly.',
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag off)": OK(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag on)": OK(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
  },
  'blocks.getReactionsForApp': {
    'valid token': OK(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42', 'hydrate:42']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], ['bridge-auth:threw']),
    revoked: E('FORBIDDEN', 'block instance revoked', [], ['bridge-auth:threw']),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], ['bridge-auth:threw']),
    'missing scope': E('FORBIDDEN', 'block lacks social:react:self scope', [], ['bridge-auth:ok']),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'reacting requires a signed-in viewer',
      [],
      ['bridge-auth:ok']
    ),
    'flag off': E(
      'UNAUTHORIZED',
      'Apps are not enabled',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:threw:42']
    ),
    'rate limited': E(
      'TOO_MANY_REQUESTS',
      'Rate limit exceeded, please retry shortly.',
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42', 'hydrate:42']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'FORBIDDEN',
      'this app session belongs to a different account; reload the page to continue',
      [],
      ['bridge-auth:ok']
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'FORBIDDEN',
      'this app session belongs to a different account; reload the page to continue',
      [],
      ['bridge-auth:ok']
    ),
  },
  'blocks.listMyWorkflows': {
    'valid token': OK([], ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], ['bridge-auth:threw']),
    revoked: E('FORBIDDEN', 'block instance revoked', [], ['bridge-auth:threw']),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], ['bridge-auth:threw']),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', [], ['bridge-auth:ok']),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'workflow list requires authenticated viewer',
      [],
      ['bridge-auth:ok']
    ),
    'flag off': E(
      'UNAUTHORIZED',
      'Apps are not enabled',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:threw:42']
    ),
    'rate limited': OK([], ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']),
    "session user is not the token subject (session user's run flag off)": OK(
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag on)": OK(
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
  },
  'blocks.persistAppUploadImage': {
    'valid token': PASSED(
      ['checkBlockUploadAppRateLimit("app_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42', 'hydrate:42']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], ['bridge-auth:threw']),
    revoked: E('FORBIDDEN', 'block instance revoked', [], ['bridge-auth:threw']),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], ['bridge-auth:threw']),
    'missing scope': E('FORBIDDEN', 'block lacks posts:write:self scope', [], ['bridge-auth:ok']),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'posting requires an authenticated viewer',
      [],
      ['bridge-auth:ok']
    ),
    'flag off': E(
      'UNAUTHORIZED',
      'Apps are not enabled',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:threw:42']
    ),
    'rate limited': E(
      'TOO_MANY_REQUESTS',
      'This app is handling too many uploads right now, please retry shortly.',
      ['checkBlockUploadAppRateLimit("app_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42', 'hydrate:42']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'FORBIDDEN',
      'this app session belongs to a different account; reload the page to continue',
      [],
      ['bridge-auth:ok']
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'FORBIDDEN',
      'this app session belongs to a different account; reload the page to continue',
      [],
      ['bridge-auth:ok']
    ),
  },
  'blocks.pollWorkflow': {
    'valid token': PASSED(
      ['checkBlockPollRateLimit("bki_char", 42)'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], ['bridge-auth:threw']),
    revoked: E('FORBIDDEN', 'block instance revoked', [], ['bridge-auth:threw']),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], ['bridge-auth:threw']),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', [], ['bridge-auth:ok']),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'workflow poll requires authenticated viewer',
      [],
      ['bridge-auth:ok']
    ),
    'flag off': E(
      'UNAUTHORIZED',
      'Apps are not enabled',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:threw:42']
    ),
    'rate limited': OK(
      ['checkBlockPollRateLimit("bki_char", 42)'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag off)": PASSED(
      ['checkBlockPollRateLimit("bki_char", 42)'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag on)": PASSED(
      ['checkBlockPollRateLimit("bki_char", 42)'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
  },
  'blocks.previewPostFromApp': {
    'valid token': PASSED(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42', 'hydrate:42']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], ['bridge-auth:threw']),
    revoked: E('FORBIDDEN', 'block instance revoked', [], ['bridge-auth:threw']),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], ['bridge-auth:threw']),
    'missing scope': E('FORBIDDEN', 'block lacks posts:write:self scope', [], ['bridge-auth:ok']),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'posting requires an authenticated viewer',
      [],
      ['bridge-auth:ok']
    ),
    'flag off': E(
      'UNAUTHORIZED',
      'Apps are not enabled',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:threw:42']
    ),
    'rate limited': E(
      'TOO_MANY_REQUESTS',
      'Rate limit exceeded, please retry shortly.',
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42', 'hydrate:42']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'FORBIDDEN',
      'this app session belongs to a different account; reload the page to continue',
      [],
      ['bridge-auth:ok']
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'FORBIDDEN',
      'this app session belongs to a different account; reload the page to continue',
      [],
      ['bridge-auth:ok']
    ),
  },
  'blocks.previewQuoteGrant': {
    'valid token': PASSED(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], ['bridge-auth:threw']),
    revoked: E('FORBIDDEN', 'block instance revoked', [], ['bridge-auth:threw']),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], ['bridge-auth:threw']),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', [], ['bridge-auth:ok']),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'training requires an authenticated viewer',
      [],
      ['bridge-auth:ok']
    ),
    'flag off': E(
      'UNAUTHORIZED',
      'Apps are not enabled',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:threw:42']
    ),
    'rate limited': E(
      'TOO_MANY_REQUESTS',
      'Rate limit exceeded, please retry shortly.',
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'FORBIDDEN',
      'this app session belongs to a different account; reload the page to continue',
      [],
      ['bridge-auth:ok']
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'FORBIDDEN',
      'this app session belongs to a different account; reload the page to continue',
      [],
      ['bridge-auth:ok']
    ),
  },
  'blocks.previewTrainingQuote': {
    'valid token': PASSED(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], ['bridge-auth:threw']),
    revoked: E('FORBIDDEN', 'block instance revoked', [], ['bridge-auth:threw']),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], ['bridge-auth:threw']),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', [], ['bridge-auth:ok']),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'training requires an authenticated viewer',
      [],
      ['bridge-auth:ok']
    ),
    'flag off': E(
      'UNAUTHORIZED',
      'Apps are not enabled',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:threw:42']
    ),
    'rate limited': E(
      'TOO_MANY_REQUESTS',
      'Rate limit exceeded, please retry shortly.',
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'FORBIDDEN',
      'this app session belongs to a different account; reload the page to continue',
      [],
      ['bridge-auth:ok']
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'FORBIDDEN',
      'this app session belongs to a different account; reload the page to continue',
      [],
      ['bridge-auth:ok']
    ),
  },
  'blocks.publishGenerationOutputs': {
    'valid token': E(
      'FORBIDDEN',
      'workflow is not in this app subqueue',
      ['checkBlockPublishRateLimit("bki_char", 1)'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], ['bridge-auth:threw']),
    revoked: E('FORBIDDEN', 'block instance revoked', [], ['bridge-auth:threw']),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], ['bridge-auth:threw']),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', [], ['bridge-auth:ok']),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'publishing requires an authenticated viewer',
      [],
      ['bridge-auth:ok']
    ),
    'flag off': E(
      'UNAUTHORIZED',
      'Apps are not enabled',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:threw:42']
    ),
    'rate limited': E(
      'TOO_MANY_REQUESTS',
      'Rate limit exceeded, please retry shortly.',
      ['checkBlockPublishRateLimit("bki_char", 1)'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'FORBIDDEN',
      'this app session belongs to a different account; reload the page to continue',
      [],
      ['bridge-auth:ok']
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'FORBIDDEN',
      'this app session belongs to a different account; reload the page to continue',
      [],
      ['bridge-auth:ok']
    ),
  },
  'blocks.queryAppWorkflows': {
    'valid token': PASSED(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], ['bridge-auth:threw']),
    revoked: E('FORBIDDEN', 'block instance revoked', [], ['bridge-auth:threw']),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], ['bridge-auth:threw']),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', [], ['bridge-auth:ok']),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'workflow query requires authenticated viewer',
      [],
      ['bridge-auth:ok']
    ),
    'flag off': E(
      'UNAUTHORIZED',
      'Apps are not enabled',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:threw:42']
    ),
    'rate limited': E(
      'TOO_MANY_REQUESTS',
      'Rate limit exceeded, please retry shortly.',
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag off)": PASSED(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag on)": PASSED(
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
  },
  'blocks.setReactionFromApp': {
    // The ticket-less valid token stops at the PROVENANCE guard, after every identity gate.
    'valid token': E(
      'FORBIDDEN',
      'reaction ticket is missing, expired or not issued to this app and viewer',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42', 'hydrate:42']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], ['bridge-auth:threw']),
    revoked: E('FORBIDDEN', 'block instance revoked', [], ['bridge-auth:threw']),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], ['bridge-auth:threw']),
    'missing scope': E('FORBIDDEN', 'block lacks social:react:self scope', [], ['bridge-auth:ok']),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'reacting requires a signed-in viewer',
      [],
      ['bridge-auth:ok']
    ),
    'flag off': E(
      'UNAUTHORIZED',
      'Apps are not enabled',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:threw:42']
    ),
    // Charged by the shared site-reaction middleware, which this table does not spy (it is
    // skipped under test), so no bucket here refuses it and the cell is the valid-token one.
    'rate limited': E(
      'FORBIDDEN',
      'reaction ticket is missing, expired or not issued to this app and viewer',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42', 'hydrate:42']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'FORBIDDEN',
      'this app session belongs to a different account; reload the page to continue',
      [],
      ['bridge-auth:ok']
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'FORBIDDEN',
      'this app session belongs to a different account; reload the page to continue',
      [],
      ['bridge-auth:ok']
    ),
  },
  'blocks.submitWorkflow': {
    'valid token': PASSED([], ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], ['bridge-auth:threw']),
    revoked: E('FORBIDDEN', 'block instance revoked', [], ['bridge-auth:threw']),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], ['bridge-auth:threw']),
    'missing scope': E('FORBIDDEN', 'block lacks ai:write:budgeted scope', [], ['bridge-auth:ok']),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'workflow submit requires authenticated viewer',
      [],
      ['bridge-auth:ok']
    ),
    'flag off': E(
      'UNAUTHORIZED',
      'Apps are not enabled',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:threw:42']
    ),
    'rate limited': PASSED([], ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']),
    "session user is not the token subject (session user's run flag off)": PASSED(
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
    "session user is not the token subject (session user's run flag on)": PASSED(
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42']
    ),
  },
  'blocks.updateUserSettings': {
    'valid token': E(
      'FORBIDDEN',
      'Apps authoring is not enabled for this account',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42', 'hydrate:42']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], ['bridge-auth:threw']),
    revoked: E('FORBIDDEN', 'block instance revoked', [], ['bridge-auth:threw']),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], ['bridge-auth:threw']),
    'missing scope': E(
      'FORBIDDEN',
      'Apps authoring is not enabled for this account',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42', 'hydrate:42']
    ),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'anon viewers cannot persist block settings',
      [],
      ['bridge-auth:ok']
    ),
    'flag off': E(
      'UNAUTHORIZED',
      'Apps are not enabled',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:threw:42']
    ),
    'rate limited': E(
      'FORBIDDEN',
      'Apps authoring is not enabled for this account',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42', 'hydrate:42']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'FORBIDDEN',
      'Apps authoring is not enabled for this account',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42', 'hydrate:42']
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'FORBIDDEN',
      'Apps authoring is not enabled for this account',
      [],
      ['bridge-auth:ok', 'hydrate:42', 'subject-gate:ok:42', 'hydrate:42']
    ),
  },
  'apps.storage.get': {
    'valid token': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], []),
    revoked: E('FORBIDDEN', 'block instance revoked', [], []),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], []),
    'missing scope': E('FORBIDDEN', 'storage get requires the apps:storage:read scope', [], []),
    'anonymous subject': OK([], []),
    'flag off': E('UNAUTHORIZED', 'Apps access is not enabled for this browser session', [], []),
    'rate limited': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'UNAUTHORIZED',
      'Apps access is not enabled for this browser session',
      [],
      []
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
  },
  'apps.storage.set': {
    'valid token': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], []),
    revoked: E('FORBIDDEN', 'block instance revoked', [], []),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], []),
    'missing scope': E('FORBIDDEN', 'storage set requires the apps:storage:write scope', [], []),
    'anonymous subject': E('UNAUTHORIZED', 'storage requires an authenticated viewer', [], []),
    'flag off': E('UNAUTHORIZED', 'Apps access is not enabled for this browser session', [], []),
    'rate limited': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'UNAUTHORIZED',
      'Apps access is not enabled for this browser session',
      [],
      []
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
  },
  'apps.storage.delete': {
    'valid token': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], []),
    revoked: E('FORBIDDEN', 'block instance revoked', [], []),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], []),
    'missing scope': E('FORBIDDEN', 'storage delete requires the apps:storage:write scope', [], []),
    'anonymous subject': E('UNAUTHORIZED', 'storage requires an authenticated viewer', [], []),
    'flag off': E('UNAUTHORIZED', 'Apps access is not enabled for this browser session', [], []),
    'rate limited': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'UNAUTHORIZED',
      'Apps access is not enabled for this browser session',
      [],
      []
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
  },
  'apps.storage.list': {
    'valid token': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], []),
    revoked: E('FORBIDDEN', 'block instance revoked', [], []),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], []),
    'missing scope': E('FORBIDDEN', 'storage list requires the apps:storage:read scope', [], []),
    'anonymous subject': OK([], []),
    'flag off': E('UNAUTHORIZED', 'Apps access is not enabled for this browser session', [], []),
    'rate limited': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'UNAUTHORIZED',
      'Apps access is not enabled for this browser session',
      [],
      []
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
  },
  'apps.storage.getQuota': {
    'valid token': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], []),
    revoked: E('FORBIDDEN', 'block instance revoked', [], []),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], []),
    'missing scope': E(
      'FORBIDDEN',
      'storage getQuota requires the apps:storage:read scope',
      [],
      []
    ),
    'anonymous subject': OK([], []),
    'flag off': E('UNAUTHORIZED', 'Apps access is not enabled for this browser session', [], []),
    'rate limited': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'UNAUTHORIZED',
      'Apps access is not enabled for this browser session',
      [],
      []
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
  },
  'apps.shared.list': {
    'valid token': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], []),
    revoked: E('FORBIDDEN', 'block instance revoked', [], []),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], []),
    'missing scope': E(
      'FORBIDDEN',
      'shared storage list requires the apps:storage:shared:read scope',
      [],
      []
    ),
    'anonymous subject': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['apps-db']
    ),
    'flag off': E('FORBIDDEN', 'shared storage is not enabled', [], ['hydrate:42']),
    'rate limited': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
  },
  'apps.shared.get': {
    'valid token': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], []),
    revoked: E('FORBIDDEN', 'block instance revoked', [], []),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], []),
    'missing scope': E(
      'FORBIDDEN',
      'shared storage get requires the apps:storage:shared:read scope',
      [],
      []
    ),
    'anonymous subject': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['apps-db']
    ),
    'flag off': E('FORBIDDEN', 'shared storage is not enabled', [], ['hydrate:42']),
    'rate limited': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
  },
  'apps.shared.getCount': {
    'valid token': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], []),
    revoked: E('FORBIDDEN', 'block instance revoked', [], []),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], []),
    'missing scope': E(
      'FORBIDDEN',
      'shared storage getCount requires the apps:storage:shared:read scope',
      [],
      []
    ),
    'anonymous subject': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['apps-db']
    ),
    'flag off': E('FORBIDDEN', 'shared storage is not enabled', [], ['hydrate:42']),
    'rate limited': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
  },
  'apps.shared.getCounts': {
    'valid token': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], []),
    revoked: E('FORBIDDEN', 'block instance revoked', [], []),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], []),
    'missing scope': E(
      'FORBIDDEN',
      'shared storage getCount requires the apps:storage:shared:read scope',
      [],
      []
    ),
    'anonymous subject': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['apps-db']
    ),
    'flag off': E('FORBIDDEN', 'shared storage is not enabled', [], ['hydrate:42']),
    'rate limited': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      [],
      ['hydrate:42', 'apps-db']
    ),
  },
  'apps.shared.append': {
    'valid token': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      ['reserveSharedWrite(42, "apb_row")'],
      ['hydrate:42', 'apps-db']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], []),
    revoked: E('FORBIDDEN', 'block instance revoked', [], []),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], []),
    'missing scope': E(
      'FORBIDDEN',
      'shared storage append requires the apps:storage:shared:write scope',
      [],
      []
    ),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'shared storage writes require an authenticated viewer',
      [],
      []
    ),
    'flag off': E('FORBIDDEN', 'shared storage is not enabled', [], ['hydrate:42']),
    'rate limited': E(
      'TOO_MANY_REQUESTS',
      'Too many submissions — retry in 7s',
      ['reserveSharedWrite(42, "apb_row")'],
      ['hydrate:42']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      ['reserveSharedWrite(42, "apb_row")'],
      ['hydrate:42', 'apps-db']
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      ['reserveSharedWrite(42, "apb_row")'],
      ['hydrate:42', 'apps-db']
    ),
  },
  'apps.shared.update': {
    'valid token': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      ['reserveSharedWrite(42, "apb_row")'],
      ['hydrate:42', 'apps-db']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], []),
    revoked: E('FORBIDDEN', 'block instance revoked', [], []),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], []),
    'missing scope': E(
      'FORBIDDEN',
      'shared storage update requires the apps:storage:shared:write scope',
      [],
      []
    ),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'shared storage writes require an authenticated viewer',
      [],
      []
    ),
    'flag off': E('FORBIDDEN', 'shared storage is not enabled', [], ['hydrate:42']),
    'rate limited': E(
      'TOO_MANY_REQUESTS',
      'Too many submissions — retry in 7s',
      ['reserveSharedWrite(42, "apb_row")'],
      ['hydrate:42']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      ['reserveSharedWrite(42, "apb_row")'],
      ['hydrate:42', 'apps-db']
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      ['reserveSharedWrite(42, "apb_row")'],
      ['hydrate:42', 'apps-db']
    ),
  },
  'apps.shared.vote': {
    'valid token': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      ['checkSharedVoteRateLimit(42, "apb_row")'],
      ['hydrate:42', 'apps-db']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], []),
    revoked: E('FORBIDDEN', 'block instance revoked', [], []),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], []),
    'missing scope': E(
      'FORBIDDEN',
      'shared storage vote requires the apps:storage:shared:write scope',
      [],
      []
    ),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'shared storage writes require an authenticated viewer',
      [],
      []
    ),
    'flag off': E('FORBIDDEN', 'shared storage is not enabled', [], ['hydrate:42']),
    'rate limited': E(
      'TOO_MANY_REQUESTS',
      'Too many votes — retry in 7s',
      ['checkSharedVoteRateLimit(42, "apb_row")'],
      ['hydrate:42']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      ['checkSharedVoteRateLimit(42, "apb_row")'],
      ['hydrate:42', 'apps-db']
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      ['checkSharedVoteRateLimit(42, "apb_row")'],
      ['hydrate:42', 'apps-db']
    ),
  },
  'apps.shared.unvote': {
    'valid token': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      ['checkSharedVoteRateLimit(42, "apb_row")'],
      ['hydrate:42', 'apps-db']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], []),
    revoked: E('FORBIDDEN', 'block instance revoked', [], []),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], []),
    'missing scope': E(
      'FORBIDDEN',
      'shared storage unvote requires the apps:storage:shared:write scope',
      [],
      []
    ),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'shared storage writes require an authenticated viewer',
      [],
      []
    ),
    'flag off': E('FORBIDDEN', 'shared storage is not enabled', [], ['hydrate:42']),
    'rate limited': E(
      'TOO_MANY_REQUESTS',
      'Too many votes — retry in 7s',
      ['checkSharedVoteRateLimit(42, "apb_row")'],
      ['hydrate:42']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      ['checkSharedVoteRateLimit(42, "apb_row")'],
      ['hydrate:42', 'apps-db']
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      ['checkSharedVoteRateLimit(42, "apb_row")'],
      ['hydrate:42', 'apps-db']
    ),
  },
  'apps.shared.withdraw': {
    'valid token': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      ['checkSharedWithdrawRateLimit(42, "apb_row")'],
      ['hydrate:42', 'apps-db']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], []),
    revoked: E('FORBIDDEN', 'block instance revoked', [], []),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], []),
    'missing scope': E(
      'FORBIDDEN',
      'shared storage withdraw requires the apps:storage:shared:write scope',
      [],
      []
    ),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'shared storage writes require an authenticated viewer',
      [],
      []
    ),
    'flag off': E('FORBIDDEN', 'shared storage is not enabled', [], ['hydrate:42']),
    'rate limited': E(
      'TOO_MANY_REQUESTS',
      'Too many withdrawals — retry in 7s',
      ['checkSharedWithdrawRateLimit(42, "apb_row")'],
      ['hydrate:42']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      ['checkSharedWithdrawRateLimit(42, "apb_row")'],
      ['hydrate:42', 'apps-db']
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      ['checkSharedWithdrawRateLimit(42, "apb_row")'],
      ['hydrate:42', 'apps-db']
    ),
  },
  'apps.shared.report': {
    'valid token': E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      ['checkSharedReportRateLimit(42, "apb_row")'],
      ['hydrate:42', 'apps-db']
    ),
    'garbage token': E('UNAUTHORIZED', 'invalid block token', [], []),
    revoked: E('FORBIDDEN', 'block instance revoked', [], []),
    'not approved': E('FORBIDDEN', 'app block is not approved', [], []),
    'missing scope': E(
      'FORBIDDEN',
      'shared storage report requires the apps:storage:shared:write scope',
      [],
      []
    ),
    'anonymous subject': E(
      'UNAUTHORIZED',
      'shared storage writes require an authenticated viewer',
      [],
      []
    ),
    'flag off': E('FORBIDDEN', 'shared storage is not enabled', [], ['hydrate:42']),
    'rate limited': E(
      'TOO_MANY_REQUESTS',
      'Too many reports — retry in 7s',
      ['checkSharedReportRateLimit(42, "apb_row")'],
      ['hydrate:42']
    ),
    "session user is not the token subject (session user's run flag off)": E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      ['checkSharedReportRateLimit(42, "apb_row")'],
      ['hydrate:42', 'apps-db']
    ),
    "session user is not the token subject (session user's run flag on)": E(
      'INTERNAL_SERVER_ERROR',
      'PAST_AUTH: reached the apps-db pool',
      ['checkSharedReportRateLimit(42, "apb_row")'],
      ['hydrate:42', 'apps-db']
    ),
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
        // `apps.storage.*` also run with session = subject: their procedure middleware evaluates
        // the run flag for the SESSION user, which (flags being subject-only) would otherwise
        // refuse every cell; their `session user is not the token subject` cell pins that.
        h.sessionUserId.id =
          SESSION_BOUND.has(path) || path.startsWith('apps.storage.')
            ? SUBJECT_ID
            : SESSION_USER_ID;
        const got = await CELLS[cell](path);
        expect(got.limiter, 'rate-limiter calls (name + bucket arguments, in order)').toEqual(
          want.limiter
        );
        expect(got.reached, 'auth anchors passed (resolver / subject gate / apps-db)').toEqual(
          want.reached
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
