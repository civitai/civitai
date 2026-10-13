import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Setup-order import: installs the shared db/redis/env/prom mocks and the REAL test RSA keypair
// before `block-token.service` evaluates env at module load, so tokens below are really signed
// and really verified.
import '~/__tests__/setup';
import fs from 'node:fs';
import path from 'node:path';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';
import type * as ConsentRevocationModule from '~/server/services/blocks/consent-revocation.service';
import type * as DevTunnelModule from '~/server/services/blocks/dev-tunnel.service';
import type * as CatalogRateLimit from '~/server/utils/block-catalog-rate-limit';
import type * as GoodsRateLimit from '~/server/utils/block-goods-rate-limit';
import type * as TipRateLimit from '~/server/utils/block-tip-rate-limit';
import type * as SharedRateLimit from '~/server/utils/shared-storage-rate-limit';
import type * as BlockGoodsService from '~/server/services/blocks/block-goods.service';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as ScopeGrantService from '~/server/services/blocks/scope-grant.service';

/**
 * CHARACTERISATION — every REST route wrapped in `withBlockScope`, today.
 *
 * Drives the REAL route modules (as the page exports them), through the REAL middleware, with
 * REAL RS256 block JWTs minted by `BlockTokenService.sign`. Each cell is the response the
 * caller sees (status + body), whether the middleware ADMITTED the request to the wrapped
 * handler (`req.blockClaims` set), and every rate-limiter call the request made.
 *
 * Why this exists: the block-token resolvers are being consolidated, and the REST wrapper is
 * the fourth resolver order (CORS → bearer → runtime flag → verify → revocation → consent →
 * approval → required scope → context binding → handler). This table is what a consolidating
 * change must leave green, or edit by hand cell by cell.
 *
 * Nothing here is derived from the code under test. The route list is derived from the FILES
 * (every `src/pages/**` module that calls `withBlockScope(`) and asserted equal to the table's
 * keys, so a new route without a row fails.
 *
 * The deliberate REST-side differences, quoted from `block-scope.middleware.ts`:
 *   > 🔴 WHICH VERDICTS REFUSE IS NOT UNIFORM ACROSS THE FOUR, AND FOR ONE OF THEM IT IS NOT
 *   > UNIFORM ACROSS ROUTES EITHER. […] `not_found` — ALWAYS SERVED.
 *   > ⚠️ THIS SAID "AND MIRRORS THE BRIDGE", WHICH IS FALSE FOR THE CONSENT LEG. Here the
 *   > per-scope consent check runs BEFORE this DB read; on the bridge it runs AFTER
 *   > `assertAppBlockApproved`.
 * and from `block-bridge-auth.service.ts`:
 *   > the REST wrapper counts it and SERVES the request, because a 404 there lands on a public
 *   > HTTP endpoint and a missing row is a healthy app […] Do not "fix" that difference
 *   > without deciding it.
 *
 * ## How to read an ADMITTED cell
 *
 * Once the middleware admits a request the wrapped handler runs, and what it answers past
 * its own auth checks depends on services this file does not set up (the cell's job is the
 * auth path, not the feature). Those cells are pinned as `admitted: true` plus the limiter
 * calls and the response's STATUS CLASS only — never a body produced by an unconfigured
 * downstream mock. Cells refused before or by the middleware, and handler-level auth refusals
 * (the handler's own 401/405, a second token verification, a 429), are pinned verbatim.
 */

const h = vi.hoisted(() => ({
  runtimeFlag: { on: true },
  isRevoked: vi.fn(),
  consentLookup: vi.fn(),
  getActiveDevTunnel: vi.fn(),
  getSessionUserById: vi.fn(),
  getSessionFromBearerToken: vi.fn(),
  limiter: { deny: false },
  limiterCalls: [] as string[],
  grantedScopes: [] as string[],
}));

vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof AppBlocksFlag>()),
  isAppBlocksRuntimeEnabled: async () => h.runtimeFlag.on,
  isAppBlocksEnabled: async () => true,
  isAppBlocksSharedStorageEnabled: async () => true,
  // Pinned OFF so the one route that consults the authoring capability answers the same
  // way on every machine, rather than whatever the flag client resolves to locally.
  isAppBlocksAuthorEnabled: async () => false,
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
vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: (...a: unknown[]) => h.getSessionFromBearerToken(...a),
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
/**
 * The three fixtures that let a request REACH a limiter that sits behind a non-auth step:
 * a purchasable good (goods/purchase resolves it before charging the bucket), the dark
 * `resourceIntentJev` feature (resource-intent 404s before its limiter otherwise), and a
 * granted consent row for the hub-token cell (so the hub claims carry the route's scope and
 * the request reaches the handler's own second verification).
 */
vi.mock('~/server/services/blocks/block-goods.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlockGoodsService>()),
  resolveBlockGoodForPurchase: async () => ({ good: { priceBuzz: 10 } }),
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => {
  const real = await importOriginal<typeof FeatureFlagsService>();
  return {
    ...real,
    getFeatureFlags: (...a: Parameters<typeof real.getFeatureFlags>) => {
      let base: Record<string, unknown> = {};
      try {
        base = real.getFeatureFlags(...a) as unknown as Record<string, unknown>;
      } catch {
        base = {};
      }
      return { ...base, resourceIntentJev: true };
    },
  };
});
vi.mock('~/server/services/blocks/scope-grant.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ScopeGrantService>()),
  getGrantedScopes: async () => new Set(h.grantedScopes),
}));

/**
 * Every rate limiter a block route can reach, recorded by NAME and ARGUMENTS. The bucket a
 * request is charged to is identified by those arguments, so a consolidation that changes the
 * key (or charges a refused request) moves a cell here.
 */
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
vi.mock('~/server/utils/block-goods-rate-limit', async (importOriginal) => {
  const real = await importOriginal<typeof GoodsRateLimit>();
  const out: Record<string, unknown> = { ...real };
  for (const k of Object.keys(real)) if (/^check.*RateLimit$/.test(k)) out[k] = limiterSpy(k);
  return out;
});
vi.mock('~/server/utils/block-tip-rate-limit', async (importOriginal) => {
  const real = await importOriginal<typeof TipRateLimit>();
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
import { env } from '~/__tests__/mocks/env.mock';
import { BlockTokenService } from '~/server/services/block-token.service';
import { OnboardingSteps } from '~/server/common/enums';

/** A body every workflow route's schema accepts (the shape the workflow suites use). */
const WORKFLOW_BODY = {
  kind: 'textToImage',
  modelId: 7,
  modelVersionId: 99,
  params: { prompt: 'a cat', quantity: 1 },
};

// ── routes ───────────────────────────────────────────────────────────────────────────────

type RouteSpec = {
  load: () => Promise<{ default: unknown }>;
  method: 'GET' | 'POST';
  query?: Record<string, string>;
  body?: unknown;
  /** The `requiredScope` the route declares, or null for an any-token route. */
  scope: string | null;
};

const ROUTES: Record<string, RouteSpec> = {
  'src/pages/api/v1/blocks/app-storage/delete.ts': {
    load: () => import('~/pages/api/v1/blocks/app-storage/delete'),
    method: 'POST',
    body: { key: 'k' },
    scope: 'apps:storage:write',
  },
  'src/pages/api/v1/blocks/app-storage/get.ts': {
    load: () => import('~/pages/api/v1/blocks/app-storage/get'),
    method: 'POST',
    body: { key: 'k' },
    scope: 'apps:storage:read',
  },
  'src/pages/api/v1/blocks/app-storage/list.ts': {
    load: () => import('~/pages/api/v1/blocks/app-storage/list'),
    method: 'POST',
    body: {},
    scope: 'apps:storage:read',
  },
  'src/pages/api/v1/blocks/app-storage/quota.ts': {
    load: () => import('~/pages/api/v1/blocks/app-storage/quota'),
    method: 'POST',
    body: {},
    scope: 'apps:storage:read',
  },
  'src/pages/api/v1/blocks/app-storage/set.ts': {
    load: () => import('~/pages/api/v1/blocks/app-storage/set'),
    method: 'POST',
    body: { key: 'k', value: 1 },
    scope: 'apps:storage:write',
  },
  'src/pages/api/v1/blocks/buzz.ts': {
    load: () => import('~/pages/api/v1/blocks/buzz'),
    method: 'GET',
    scope: 'buzz:read:self',
  },
  'src/pages/api/v1/blocks/collections/[id]/follow.ts': {
    load: () => import('~/pages/api/v1/blocks/collections/[id]/follow'),
    method: 'POST',
    query: { id: '99' },
    body: { follow: true },
    scope: 'collections:write:self',
  },
  'src/pages/api/v1/blocks/collections/[id]/index.ts': {
    load: () => import('~/pages/api/v1/blocks/collections/[id]/index'),
    method: 'GET',
    query: { id: '99' },
    scope: 'collections:read:self',
  },
  'src/pages/api/v1/blocks/collections/index.ts': {
    load: () => import('~/pages/api/v1/blocks/collections/index'),
    method: 'GET',
    scope: 'collections:read:self',
  },
  'src/pages/api/v1/blocks/entitlements.ts': {
    load: () => import('~/pages/api/v1/blocks/entitlements'),
    method: 'GET',
    scope: 'goods:read:self',
  },
  'src/pages/api/v1/blocks/gated-images.ts': {
    load: () => import('~/pages/api/v1/blocks/gated-images'),
    method: 'GET',
    query: { ids: '1' },
    scope: null,
  },
  'src/pages/api/v1/blocks/generation-resources.ts': {
    load: () => import('~/pages/api/v1/blocks/generation-resources'),
    method: 'GET',
    query: { ids: '1' },
    scope: null,
  },
  'src/pages/api/v1/blocks/goods/purchase.ts': {
    load: () => import('~/pages/api/v1/blocks/goods/purchase'),
    method: 'POST',
    body: { goodId: 'g', quantity: 1 },
    scope: 'goods:purchase:self',
  },
  'src/pages/api/v1/blocks/images.ts': {
    load: () => import('~/pages/api/v1/blocks/images'),
    method: 'GET',
    scope: null,
  },
  'src/pages/api/v1/blocks/me.ts': {
    load: () => import('~/pages/api/v1/blocks/me'),
    method: 'GET',
    scope: 'user:read:self',
  },
  'src/pages/api/v1/blocks/models.ts': {
    load: () => import('~/pages/api/v1/blocks/models'),
    method: 'GET',
    scope: null,
  },
  'src/pages/api/v1/blocks/resource-intent.ts': {
    load: () => import('~/pages/api/v1/blocks/resource-intent'),
    method: 'POST',
    body: { prompt: 'a cat' },
    scope: null,
  },
  'src/pages/api/v1/blocks/shared-storage/append.ts': {
    load: () => import('~/pages/api/v1/blocks/shared-storage/append'),
    method: 'POST',
    body: { value: { title: 't' } },
    scope: 'apps:storage:shared:write',
  },
  'src/pages/api/v1/blocks/shared-storage/counts.ts': {
    load: () => import('~/pages/api/v1/blocks/shared-storage/counts'),
    method: 'GET',
    query: { keys: 'k' },
    scope: 'apps:storage:shared:read',
  },
  'src/pages/api/v1/blocks/shared-storage/increment.ts': {
    load: () => import('~/pages/api/v1/blocks/shared-storage/increment'),
    method: 'POST',
    body: { key: 'playcount:1' },
    scope: 'apps:storage:shared:write',
  },
  'src/pages/api/v1/blocks/shared-storage/item.ts': {
    load: () => import('~/pages/api/v1/blocks/shared-storage/item'),
    method: 'GET',
    query: { key: 'k' },
    scope: 'apps:storage:shared:read',
  },
  'src/pages/api/v1/blocks/shared-storage/list.ts': {
    load: () => import('~/pages/api/v1/blocks/shared-storage/list'),
    method: 'GET',
    scope: 'apps:storage:shared:read',
  },
  'src/pages/api/v1/blocks/shared-storage/report.ts': {
    load: () => import('~/pages/api/v1/blocks/shared-storage/report'),
    method: 'POST',
    body: { key: 'k' },
    scope: 'apps:storage:shared:write',
  },
  'src/pages/api/v1/blocks/shared-storage/top.ts': {
    load: () => import('~/pages/api/v1/blocks/shared-storage/top'),
    method: 'GET',
    scope: 'apps:storage:shared:read',
  },
  'src/pages/api/v1/blocks/shared-storage/unvote.ts': {
    load: () => import('~/pages/api/v1/blocks/shared-storage/unvote'),
    method: 'POST',
    body: { key: 'k' },
    scope: 'apps:storage:shared:write',
  },
  'src/pages/api/v1/blocks/shared-storage/update.ts': {
    load: () => import('~/pages/api/v1/blocks/shared-storage/update'),
    method: 'POST',
    body: { key: 'k', value: { title: 't' } },
    scope: 'apps:storage:shared:write',
  },
  'src/pages/api/v1/blocks/shared-storage/vote.ts': {
    load: () => import('~/pages/api/v1/blocks/shared-storage/vote'),
    method: 'POST',
    body: { key: 'k' },
    scope: 'apps:storage:shared:write',
  },
  'src/pages/api/v1/blocks/shared-storage/withdraw.ts': {
    load: () => import('~/pages/api/v1/blocks/shared-storage/withdraw'),
    method: 'POST',
    body: { key: 'k' },
    scope: 'apps:storage:shared:write',
  },
  'src/pages/api/v1/blocks/sub-listings/mine.ts': {
    load: () => import('~/pages/api/v1/blocks/sub-listings/mine'),
    method: 'GET',
    scope: 'apps:store:items:write',
  },
  'src/pages/api/v1/blocks/sub-listings/upsert.ts': {
    load: () => import('~/pages/api/v1/blocks/sub-listings/upsert'),
    method: 'POST',
    body: {},
    scope: 'apps:store:items:write',
  },
  'src/pages/api/v1/blocks/sub-listings/withdraw.ts': {
    load: () => import('~/pages/api/v1/blocks/sub-listings/withdraw'),
    method: 'POST',
    body: {},
    scope: 'apps:store:items:write',
  },
  'src/pages/api/v1/blocks/tip-allowance.ts': {
    load: () => import('~/pages/api/v1/blocks/tip-allowance'),
    method: 'GET',
    scope: 'social:tip:self',
  },
  'src/pages/api/v1/blocks/tip.ts': {
    load: () => import('~/pages/api/v1/blocks/tip'),
    method: 'POST',
    body: { toUserId: 77, amount: 100 },
    scope: 'social:tip:self',
  },
  'src/pages/api/v1/blocks/tools.ts': {
    load: () => import('~/pages/api/v1/blocks/tools'),
    method: 'POST',
    body: { name: 'search_models', arguments: { query: 'cat' } },
    scope: null,
  },
  'src/pages/api/v1/blocks/user-checkpoint/set.ts': {
    load: () => import('~/pages/api/v1/blocks/user-checkpoint/set'),
    method: 'POST',
    body: { versionId: 1 },
    scope: null,
  },
  'src/pages/api/v1/blocks/workflows/cancel.ts': {
    load: () => import('~/pages/api/v1/blocks/workflows/cancel'),
    method: 'POST',
    body: { workflowId: 'wf_1' },
    scope: 'ai:write:budgeted',
  },
  'src/pages/api/v1/blocks/workflows/estimate.ts': {
    load: () => import('~/pages/api/v1/blocks/workflows/estimate'),
    method: 'POST',
    body: { body: WORKFLOW_BODY },
    scope: 'ai:write:budgeted',
  },
  'src/pages/api/v1/blocks/workflows/poll.ts': {
    load: () => import('~/pages/api/v1/blocks/workflows/poll'),
    method: 'POST',
    body: { workflowId: 'wf_1' },
    scope: 'ai:write:budgeted',
  },
  'src/pages/api/v1/blocks/workflows/query.ts': {
    load: () => import('~/pages/api/v1/blocks/workflows/query'),
    method: 'POST',
    body: {},
    scope: 'ai:write:budgeted',
  },
  'src/pages/api/v1/blocks/workflows/submit.ts': {
    load: () => import('~/pages/api/v1/blocks/workflows/submit'),
    method: 'POST',
    body: { body: WORKFLOW_BODY, idempotencyKey: 'idem_char' },
    scope: 'ai:write:budgeted',
  },
  'src/pages/api/v1/models/[id].ts': {
    load: () => import('~/pages/api/v1/models/[id]'),
    method: 'GET',
    query: { id: '7' },
    scope: 'models:read:self',
  },
};

// ── tokens and requests ──────────────────────────────────────────────────────────────────

const SUBJECT_ID = 42;
const TRUSTED_SUBJECT = {
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

async function mint(over: { scopes: string[]; anon?: boolean; buzzBudget?: number }) {
  const { token } = await BlockTokenService.sign({
    userId: over.anon ? null : SUBJECT_ID,
    blockId: 'char-block',
    appId: 'app_char',
    appBlockId: 'apb_char',
    blockInstanceId: 'bki_char',
    scopes: over.scopes,
    ctx: { modelId: 7, slotId: 'model.sidebar_top' },
    maxBrowsingLevel: 1,
    ...(over.buzzBudget === undefined ? { buzzBudget: 100 } : { buzzBudget: over.buzzBudget }),
  } as Parameters<typeof BlockTokenService.sign>[0]);
  return token;
}

/** A JWT-shaped string with a valid RS256/JWT header and a signature nothing will verify. */
const BAD_JWT = [
  Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'nope' })).toString('base64url'),
  Buffer.from(JSON.stringify({ sub: 'user:42' })).toString('base64url'),
  'c2lnbmF0dXJl',
].join('.');

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    ended: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      this.ended = true;
      return this;
    },
    send(payload?: unknown) {
      this.body = payload;
      this.ended = true;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
    setHeader() {
      return this;
    },
    getHeader() {
      return undefined;
    },
    removeHeader() {
      return undefined;
    },
    writeHead(code: number) {
      this.statusCode = code;
      return this;
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
    redirect(code: number) {
      this.statusCode = code;
      this.ended = true;
      return this;
    },
  };
  return res;
}

type Response = { status: number; body: unknown; admitted: boolean; limiter: string[] };

async function call(
  file: string,
  opts: { authorization?: string; method?: string }
): Promise<Response> {
  const spec = ROUTES[file];
  const mod = await spec.load();
  const handler = mod.default as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
  const req = {
    method: opts.method ?? spec.method,
    headers: opts.authorization ? { authorization: opts.authorization } : {},
    query: { ...(spec.query ?? {}) },
    body: spec.body ?? {},
    url: `/${file.replace(/^src\/pages/, '').replace(/\.ts$/, '')}`,
    cookies: {},
    socket: { remoteAddress: '203.0.113.7' },
  } as unknown as NextApiRequest & { blockClaims?: unknown };
  const res = makeRes();
  h.limiterCalls.length = 0;
  try {
    await handler(req, res as unknown as NextApiResponse);
  } catch (err) {
    return {
      status: -1,
      body: { thrown: (err as Error)?.constructor?.name, message: (err as Error)?.message },
      admitted: req.blockClaims !== undefined,
      limiter: [...h.limiterCalls],
    };
  }
  return {
    status: res.statusCode,
    body: res.body,
    admitted: req.blockClaims !== undefined,
    limiter: [...h.limiterCalls],
  };
}

// ── world ────────────────────────────────────────────────────────────────────────────────

/**
 * `Date` only is frozen, so a 429 body's `retryAt` is a literal; timers stay real. Token
 * minting and verification read the same frozen clock, so tokens stay valid.
 */
const FROZEN_NOW = new Date('2026-01-01T00:00:00.000Z');

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FROZEN_NOW);
  h.runtimeFlag.on = true;
  h.limiter.deny = false;
  h.limiterCalls.length = 0;
  h.isRevoked.mockReset().mockResolvedValue(false);
  h.consentLookup.mockReset().mockResolvedValue({ kind: 'none' });
  h.getActiveDevTunnel.mockReset().mockResolvedValue(null);
  h.getSessionUserById.mockReset().mockResolvedValue({ ...TRUSTED_SUBJECT });
  h.getSessionFromBearerToken.mockReset().mockResolvedValue(null);
  dbMock.dbRead.appBlock.findUnique.mockReset().mockResolvedValue({
    id: 'apb_char',
    status: 'approved',
  });
  dbMock.dbRead.oauthClient.findUnique.mockReset().mockResolvedValue({ userId: SUBJECT_ID });
  dbMock.dbRead.user.findUnique.mockReset().mockResolvedValue({ id: 77, deletedAt: null });
  h.grantedScopes = [];
  env.APP_BLOCK_OAUTH_TOKENS_ENABLED = false;
});

// ── cells ────────────────────────────────────────────────────────────────────────────────

type CellName =
  | 'no bearer'
  | 'wrong method, no bearer'
  | 'non-JWT bearer (OAuth tokens off)'
  | 'runtime flag off, valid JWT'
  | 'bad JWT'
  | 'revoked'
  | 'not approved'
  | 'revoked AND not approved'
  | 'missing scope'
  | 'token carries an unknown scope'
  | 'anonymous subject'
  | 'ai:write:budgeted without a positive buzzBudget'
  | 'rate limited'
  | 'hub OAuth token';

const CELLS: Record<CellName, (file: string) => Promise<Response>> = {
  'no bearer': (f) => call(f, {}),
  'wrong method, no bearer': (f) =>
    call(f, { method: ROUTES[f].method === 'GET' ? 'DELETE' : 'GET' }),
  'non-JWT bearer (OAuth tokens off)': (f) => call(f, { authorization: 'Bearer opaque-api-key' }),
  'runtime flag off, valid JWT': async (f) => {
    h.runtimeFlag.on = false;
    return call(f, { authorization: `Bearer ${await mint({ scopes: scopesFor(f) })}` });
  },
  'bad JWT': (f) => call(f, { authorization: `Bearer ${BAD_JWT}` }),
  revoked: async (f) => {
    h.isRevoked.mockResolvedValue(true);
    return call(f, { authorization: `Bearer ${await mint({ scopes: scopesFor(f) })}` });
  },
  'not approved': async (f) => {
    dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ id: 'apb_char', status: 'suspended' });
    return call(f, { authorization: `Bearer ${await mint({ scopes: scopesFor(f) })}` });
  },
  'revoked AND not approved': async (f) => {
    h.isRevoked.mockResolvedValue(true);
    dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ id: 'apb_char', status: 'suspended' });
    return call(f, { authorization: `Bearer ${await mint({ scopes: scopesFor(f) })}` });
  },
  'missing scope': async (f) => call(f, { authorization: `Bearer ${await mint({ scopes: [] })}` }),
  'token carries an unknown scope': async (f) =>
    call(f, {
      authorization: `Bearer ${await mint({ scopes: [...scopesFor(f), 'made:up:scope'] })}`,
    }),
  'anonymous subject': async (f) =>
    call(f, { authorization: `Bearer ${await mint({ scopes: scopesFor(f), anon: true })}` }),
  'ai:write:budgeted without a positive buzzBudget': async (f) =>
    call(f, { authorization: `Bearer ${await mint({ scopes: scopesFor(f), buzzBudget: 0 })}` }),
  'rate limited': async (f) => {
    h.limiter.deny = true;
    return call(f, { authorization: `Bearer ${await mint({ scopes: scopesFor(f) })}` });
  },
  'hub OAuth token': async (f) => {
    env.APP_BLOCK_OAUTH_TOKENS_ENABLED = true;
    h.grantedScopes = scopesFor(f);
    h.getSessionFromBearerToken.mockResolvedValue({
      subject: { type: 'oauth', id: 'app_char' },
      user: { id: SUBJECT_ID },
      apiKeyId: 5,
    });
    dbMock.dbRead.appBlock.findFirst.mockResolvedValue({
      id: 'apb_char',
      blockId: 'char-block',
      manifest: { scopes: scopesFor(f) },
      approvedScopes: scopesFor(f),
    });
    return call(f, { authorization: 'Bearer hub-oauth-access-token' });
  },
};

function scopesFor(file: string): string[] {
  const s = ROUTES[file].scope;
  return s ? [s] : [];
}

// ── expectations ─────────────────────────────────────────────────────────────────────────

/** A response pinned verbatim: status, body, whether the middleware admitted it, limiter calls. */
type Exact = { kind: 'exact' } & Response;
/**
 * Auth did NOT refuse: the handler answered with something past its own auth checks (a 2xx, a
 * 400 on the feature's own validation, a 404 for an absent fixture row, or a 5xx from a
 * downstream service this file does not configure). Pinned: whether the middleware admitted
 * it, the limiter calls it made, and that the status is NOT one of the refusal statuses
 * (401/403/405/429) — so a change that starts refusing here goes red.
 */
type Passed = { kind: 'passed'; admitted: boolean; limiter: string[] };

const X = (status: number, body: unknown, admitted: boolean, limiter: string[]): Exact => ({
  kind: 'exact',
  status,
  body,
  admitted,
  limiter,
});
const PASSED = (admitted: boolean, limiter: string[]): Passed => ({
  kind: 'passed',
  admitted,
  limiter,
});
const REFUSAL_STATUSES = [401, 403, 405, 429];

/**
 * THE TABLE: route file → cell → expected. Generated once from an observation run at the base
 * commit and then frozen here as literals; from now on it is edited by hand.
 *
 * Reading guide:
 *   - `no bearer` / `non-JWT bearer` / `runtime flag off`: the middleware hands the request to
 *     the wrapped handler UNTOUCHED (`admitted: false`), so what answers is the handler's own
 *     guard — `401 Block token required` everywhere except `models/[id]`, whose handler is
 *     public (dual-auth) and answers the anonymous caller past auth (PASSED).
 *   - `wrong method, no bearer`: 405 everywhere the handler checks the method first. The
 *     exception is `tools.ts`, which checks the token FIRST and answers 401.
 *   - `revoked AND not approved`: REST reports `revoked` (revocation runs before approval).
 *   - `missing scope` on the any-token routes (gated-images, generation-resources, images,
 *     models, resource-intent, tools, user-checkpoint/set): admitted — those routes declare no
 *     `requiredScope`.
 *   - `hub OAuth token`: with OAuth tokens enabled, the middleware synthesises claims for a
 *     hub-issued access token and admits it; routes that re-verify the RAW bearer as a block
 *     JWT (app-storage, shared-storage, workflows, user-checkpoint) then refuse it with their
 *     own `invalid block token`. The hub claims use the `page_<appBlockId>` instance id, which
 *     is why the limiter keys differ in that row.
 *   - `rate limited`: the limiter is stubbed to refuse. `poll` and `cancel` answer a
 *     NON-TERMINAL 200 snapshot by design instead of a 429.
 */
const EXPECTED: Record<string, Record<CellName, Exact | Passed>> = {
  'src/pages/api/v1/blocks/app-storage/delete.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:write', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      403,
      { error: 'apps:storage:write requires authenticated subject', code: 'context_binding' },
      false,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, []),
    'rate limited': PASSED(true, []),
    'hub OAuth token': X(401, { message: 'invalid block token' }, true, []),
  },
  'src/pages/api/v1/blocks/app-storage/get.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:read', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      403,
      { error: 'apps:storage:read requires authenticated subject', code: 'context_binding' },
      false,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, []),
    'rate limited': PASSED(true, []),
    'hub OAuth token': X(401, { message: 'invalid block token' }, true, []),
  },
  'src/pages/api/v1/blocks/app-storage/list.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:read', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      403,
      { error: 'apps:storage:read requires authenticated subject', code: 'context_binding' },
      false,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, []),
    'rate limited': PASSED(true, []),
    'hub OAuth token': X(401, { message: 'invalid block token' }, true, []),
  },
  'src/pages/api/v1/blocks/app-storage/quota.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:read', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      403,
      { error: 'apps:storage:read requires authenticated subject', code: 'context_binding' },
      false,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, []),
    'rate limited': PASSED(true, []),
    'hub OAuth token': X(401, { message: 'invalid block token' }, true, []),
  },
  'src/pages/api/v1/blocks/app-storage/set.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:write', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      403,
      { error: 'apps:storage:write requires authenticated subject', code: 'context_binding' },
      false,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, []),
    'rate limited': PASSED(true, []),
    'hub OAuth token': X(401, { message: 'invalid block token' }, true, []),
  },
  'src/pages/api/v1/blocks/buzz.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: buzz:read:self', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      403,
      { error: 'buzz:read:self requires authenticated subject', code: 'context_binding' },
      false,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, []),
    'rate limited': PASSED(true, []),
    'hub OAuth token': PASSED(true, []),
  },
  'src/pages/api/v1/blocks/collections/[id]/follow.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: collections:write:self', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      403,
      { error: 'collections:write:self requires authenticated subject', code: 'context_binding' },
      false,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': X(
      401,
      { error: 'You do not have permission to add contributors to this collection.' },
      true,
      []
    ),
    'rate limited': X(
      401,
      { error: 'You do not have permission to add contributors to this collection.' },
      true,
      []
    ),
    'hub OAuth token': X(
      401,
      { error: 'You do not have permission to add contributors to this collection.' },
      true,
      []
    ),
  },
  'src/pages/api/v1/blocks/collections/[id]/index.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: collections:read:self', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      403,
      { error: 'collections:read:self requires authenticated subject', code: 'context_binding' },
      false,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'rate limited': X(429, { error: 'Rate limit exceeded, please retry shortly.' }, true, [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'hub OAuth token': PASSED(true, ['checkBlockCatalogRateLimit("page_apb_char")']),
  },
  'src/pages/api/v1/blocks/collections/index.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: collections:read:self', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      403,
      { error: 'collections:read:self requires authenticated subject', code: 'context_binding' },
      false,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'rate limited': X(429, { error: 'Rate limit exceeded, please retry shortly.' }, true, [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'hub OAuth token': PASSED(true, ['checkBlockCatalogRateLimit("page_apb_char")']),
  },
  'src/pages/api/v1/blocks/entitlements.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: goods:read:self', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      403,
      { error: 'goods:read:self requires authenticated subject', code: 'context_binding' },
      false,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, [
      'checkBlockGoodReadRateLimit("bki_char", 42)',
    ]),
    'rate limited': X(429, { error: 'Rate limit exceeded, please retry shortly.' }, true, [
      'checkBlockGoodReadRateLimit("bki_char", 42)',
    ]),
    'hub OAuth token': PASSED(true, ['checkBlockGoodReadRateLimit("page_apb_char", 42)']),
  },
  'src/pages/api/v1/blocks/gated-images.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")']),
    'token carries an unknown scope': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")']),
    'anonymous subject': X(
      401,
      { message: 'gated image read requires an authenticated viewer' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")']
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'rate limited': X(429, { error: 'Rate limit exceeded, please retry shortly.' }, true, [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'hub OAuth token': PASSED(true, ['checkBlockCatalogRateLimit("page_apb_char")']),
  },
  'src/pages/api/v1/blocks/generation-resources.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")']),
    'token carries an unknown scope': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")']),
    'anonymous subject': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")']),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'rate limited': X(429, { error: 'Rate limit exceeded, please retry shortly.' }, true, [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'hub OAuth token': PASSED(true, ['checkBlockCatalogRateLimit("page_apb_char")']),
  },
  'src/pages/api/v1/blocks/goods/purchase.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: goods:purchase:self', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      403,
      { error: 'goods:purchase:self requires authenticated subject', code: 'context_binding' },
      false,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, [
      'checkBlockGoodRateLimit("bki_char", 42)',
    ]),
    'rate limited': X(429, { error: 'Too many purchases — please retry shortly.' }, true, [
      'checkBlockGoodRateLimit("bki_char", 42)',
    ]),
    'hub OAuth token': PASSED(true, ['checkBlockGoodRateLimit("page_apb_char", 42)']),
  },
  'src/pages/api/v1/blocks/images.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")']),
    'token carries an unknown scope': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")']),
    'anonymous subject': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")']),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'rate limited': X(429, { error: 'Rate limit exceeded, please retry shortly.' }, true, [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'hub OAuth token': PASSED(true, ['checkBlockCatalogRateLimit("page_apb_char")']),
  },
  'src/pages/api/v1/blocks/me.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: user:read:self', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      403,
      { error: 'user:read:self requires authenticated subject', code: 'context_binding' },
      false,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'rate limited': X(429, { error: 'Rate limit exceeded, please retry shortly.' }, true, [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'hub OAuth token': PASSED(true, ['checkBlockCatalogRateLimit("page_apb_char")']),
  },
  'src/pages/api/v1/blocks/models.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")']),
    'token carries an unknown scope': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")']),
    'anonymous subject': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")']),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'rate limited': X(429, { error: 'Rate limit exceeded, please retry shortly.' }, true, [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'hub OAuth token': PASSED(true, ['checkBlockCatalogRateLimit("page_apb_char")']),
  },
  'src/pages/api/v1/blocks/resource-intent.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': PASSED(true, ['checkBlockLLMRateLimit("bki_char")']),
    'token carries an unknown scope': PASSED(true, ['checkBlockLLMRateLimit("bki_char")']),
    'anonymous subject': PASSED(true, ['checkBlockLLMRateLimit("bki_char")']),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, [
      'checkBlockLLMRateLimit("bki_char")',
    ]),
    'rate limited': X(429, { error: 'Rate limit exceeded, please retry shortly.' }, true, [
      'checkBlockLLMRateLimit("bki_char")',
    ]),
    'hub OAuth token': PASSED(true, ['checkBlockLLMRateLimit("page_apb_char")']),
  },
  'src/pages/api/v1/blocks/shared-storage/append.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:shared:write', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      403,
      {
        error: 'apps:storage:shared:write requires authenticated subject',
        code: 'context_binding',
      },
      false,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, [
      'reserveSharedWrite(42, "apb_char")',
    ]),
    'rate limited': X(
      429,
      {
        error: 'Too many submissions — retry in 7s',
        message: 'Too many submissions — retry in 7s',
        code: 'TOO_MANY_REQUESTS',
        rateLimit: { retryAfterSeconds: 7, retryAt: '2026-01-01T00:00:07.000Z' },
      },
      true,
      ['reserveSharedWrite(42, "apb_char")']
    ),
    'hub OAuth token': X(401, { message: 'invalid block token' }, true, []),
  },
  'src/pages/api/v1/blocks/shared-storage/counts.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:shared:read', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': PASSED(true, []),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, []),
    'rate limited': PASSED(true, []),
    'hub OAuth token': X(401, { message: 'invalid block token' }, true, []),
  },
  'src/pages/api/v1/blocks/shared-storage/increment.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:shared:write', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      403,
      {
        error: 'apps:storage:shared:write requires authenticated subject',
        code: 'context_binding',
      },
      false,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, [
      'checkSharedVoteRateLimit(42, "apb_char")',
    ]),
    'rate limited': X(
      429,
      {
        error: 'Too many increments — retry in 7s',
        message: 'Too many increments — retry in 7s',
        code: 'TOO_MANY_REQUESTS',
        rateLimit: { retryAfterSeconds: 7, retryAt: '2026-01-01T00:00:07.000Z' },
      },
      true,
      ['checkSharedVoteRateLimit(42, "apb_char")']
    ),
    'hub OAuth token': X(401, { error: 'invalid block token' }, true, []),
  },
  'src/pages/api/v1/blocks/shared-storage/item.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:shared:read', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': PASSED(true, []),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, []),
    'rate limited': PASSED(true, []),
    'hub OAuth token': X(401, { message: 'invalid block token' }, true, []),
  },
  'src/pages/api/v1/blocks/shared-storage/list.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:shared:read', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': PASSED(true, []),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, []),
    'rate limited': PASSED(true, []),
    'hub OAuth token': X(401, { message: 'invalid block token' }, true, []),
  },
  'src/pages/api/v1/blocks/shared-storage/report.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:shared:write', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      403,
      {
        error: 'apps:storage:shared:write requires authenticated subject',
        code: 'context_binding',
      },
      false,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, [
      'checkSharedReportRateLimit(42, "apb_char")',
    ]),
    'rate limited': X(
      429,
      {
        error: 'Too many reports — retry in 7s',
        message: 'Too many reports — retry in 7s',
        code: 'TOO_MANY_REQUESTS',
        rateLimit: { retryAfterSeconds: 7, retryAt: '2026-01-01T00:00:07.000Z' },
      },
      true,
      ['checkSharedReportRateLimit(42, "apb_char")']
    ),
    'hub OAuth token': X(401, { message: 'invalid block token' }, true, []),
  },
  'src/pages/api/v1/blocks/shared-storage/top.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:shared:read', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': PASSED(true, []),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, []),
    'rate limited': PASSED(true, []),
    'hub OAuth token': X(401, { error: 'invalid block token' }, true, []),
  },
  'src/pages/api/v1/blocks/shared-storage/unvote.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:shared:write', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      403,
      {
        error: 'apps:storage:shared:write requires authenticated subject',
        code: 'context_binding',
      },
      false,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, [
      'checkSharedVoteRateLimit(42, "apb_char")',
    ]),
    'rate limited': X(
      429,
      {
        error: 'Too many votes — retry in 7s',
        message: 'Too many votes — retry in 7s',
        code: 'TOO_MANY_REQUESTS',
        rateLimit: { retryAfterSeconds: 7, retryAt: '2026-01-01T00:00:07.000Z' },
      },
      true,
      ['checkSharedVoteRateLimit(42, "apb_char")']
    ),
    'hub OAuth token': X(401, { message: 'invalid block token' }, true, []),
  },
  'src/pages/api/v1/blocks/shared-storage/update.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:shared:write', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      403,
      {
        error: 'apps:storage:shared:write requires authenticated subject',
        code: 'context_binding',
      },
      false,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, [
      'reserveSharedWrite(42, "apb_char")',
    ]),
    'rate limited': X(
      429,
      {
        error: 'Too many submissions — retry in 7s',
        message: 'Too many submissions — retry in 7s',
        code: 'TOO_MANY_REQUESTS',
        rateLimit: { retryAfterSeconds: 7, retryAt: '2026-01-01T00:00:07.000Z' },
      },
      true,
      ['reserveSharedWrite(42, "apb_char")']
    ),
    'hub OAuth token': X(401, { message: 'invalid block token' }, true, []),
  },
  'src/pages/api/v1/blocks/shared-storage/vote.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:shared:write', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      403,
      {
        error: 'apps:storage:shared:write requires authenticated subject',
        code: 'context_binding',
      },
      false,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, [
      'checkSharedVoteRateLimit(42, "apb_char")',
    ]),
    'rate limited': X(
      429,
      {
        error: 'Too many votes — retry in 7s',
        message: 'Too many votes — retry in 7s',
        code: 'TOO_MANY_REQUESTS',
        rateLimit: { retryAfterSeconds: 7, retryAt: '2026-01-01T00:00:07.000Z' },
      },
      true,
      ['checkSharedVoteRateLimit(42, "apb_char")']
    ),
    'hub OAuth token': X(401, { message: 'invalid block token' }, true, []),
  },
  'src/pages/api/v1/blocks/shared-storage/withdraw.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:shared:write', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      403,
      {
        error: 'apps:storage:shared:write requires authenticated subject',
        code: 'context_binding',
      },
      false,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, [
      'checkSharedWithdrawRateLimit(42, "apb_char")',
    ]),
    'rate limited': X(
      429,
      {
        error: 'Too many withdrawals — retry in 7s',
        message: 'Too many withdrawals — retry in 7s',
        code: 'TOO_MANY_REQUESTS',
        rateLimit: { retryAfterSeconds: 7, retryAt: '2026-01-01T00:00:07.000Z' },
      },
      true,
      ['checkSharedWithdrawRateLimit(42, "apb_char")']
    ),
    'hub OAuth token': X(401, { message: 'invalid block token' }, true, []),
  },
  'src/pages/api/v1/blocks/sub-listings/mine.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:store:items:write', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      403,
      { error: 'apps:store:items:write requires authenticated subject', code: 'context_binding' },
      false,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, []),
    'rate limited': PASSED(true, []),
    'hub OAuth token': PASSED(true, []),
  },
  'src/pages/api/v1/blocks/sub-listings/upsert.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:store:items:write', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      403,
      { error: 'apps:store:items:write requires authenticated subject', code: 'context_binding' },
      false,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, []),
    'rate limited': PASSED(true, []),
    'hub OAuth token': PASSED(true, []),
  },
  'src/pages/api/v1/blocks/sub-listings/withdraw.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:store:items:write', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      403,
      { error: 'apps:store:items:write requires authenticated subject', code: 'context_binding' },
      false,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, []),
    'rate limited': PASSED(true, []),
    'hub OAuth token': PASSED(true, []),
  },
  'src/pages/api/v1/blocks/tip-allowance.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: social:tip:self', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      403,
      { error: 'social:tip:self requires authenticated subject', code: 'context_binding' },
      false,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'rate limited': X(429, { error: 'Rate limit exceeded, please retry shortly.' }, true, [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'hub OAuth token': PASSED(true, ['checkBlockCatalogRateLimit("page_apb_char")']),
  },
  'src/pages/api/v1/blocks/tip.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: social:tip:self', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      403,
      { error: 'social:tip:self requires authenticated subject', code: 'context_binding' },
      false,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, [
      'checkBlockTipRateLimit("bki_char")',
    ]),
    'rate limited': X(429, { error: 'Too many tips — please retry shortly.' }, true, [
      'checkBlockTipRateLimit("bki_char")',
    ]),
    'hub OAuth token': PASSED(true, ['checkBlockTipRateLimit("page_apb_char")']),
  },
  'src/pages/api/v1/blocks/tools.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(401, { error: 'Block token required' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")']),
    'token carries an unknown scope': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")']),
    'anonymous subject': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")']),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'rate limited': X(429, { error: 'Rate limit exceeded, please retry shortly.' }, true, [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'hub OAuth token': PASSED(true, ['checkBlockCatalogRateLimit("page_apb_char")']),
  },
  'src/pages/api/v1/blocks/user-checkpoint/set.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { message: 'Apps authoring is not enabled for this account' },
      true,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { message: 'Apps authoring is not enabled for this account' },
      true,
      []
    ),
    'anonymous subject': X(
      401,
      { message: 'anon viewers cannot persist block settings' },
      true,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': X(
      403,
      { message: 'Apps authoring is not enabled for this account' },
      true,
      []
    ),
    'rate limited': X(403, { message: 'Apps authoring is not enabled for this account' }, true, []),
    'hub OAuth token': X(401, { message: 'invalid block token' }, true, []),
  },
  'src/pages/api/v1/blocks/workflows/cancel.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: ai:write:budgeted', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      401,
      { message: 'workflow cancel requires authenticated viewer' },
      true,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': X(
      403,
      { error: 'ai:write:budgeted requires positive buzzBudget claim', code: 'context_binding' },
      false,
      []
    ),
    'rate limited': X(200, { snapshot: { workflowId: 'wf_1', status: 'processing' } }, true, [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'hub OAuth token': X(401, { message: 'invalid block token' }, true, []),
  },
  'src/pages/api/v1/blocks/workflows/estimate.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: ai:write:budgeted', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(401, { message: 'estimate requires authenticated viewer' }, true, [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'ai:write:budgeted without a positive buzzBudget': X(
      403,
      { error: 'ai:write:budgeted requires positive buzzBudget claim', code: 'context_binding' },
      false,
      []
    ),
    'rate limited': X(429, { message: 'Rate limit exceeded, please retry shortly.' }, true, [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'hub OAuth token': X(401, { message: 'invalid block token' }, true, []),
  },
  'src/pages/api/v1/blocks/workflows/poll.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: ai:write:budgeted', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      401,
      { message: 'workflow poll requires authenticated viewer' },
      true,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': X(
      403,
      { error: 'ai:write:budgeted requires positive buzzBudget claim', code: 'context_binding' },
      false,
      []
    ),
    'rate limited': X(200, { snapshot: { workflowId: 'wf_1', status: 'processing' } }, true, [
      'checkBlockPollRateLimit("bki_char", 42)',
    ]),
    'hub OAuth token': X(401, { message: 'invalid block token' }, true, []),
  },
  'src/pages/api/v1/blocks/workflows/query.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: ai:write:budgeted', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      401,
      { message: 'workflow query requires authenticated viewer' },
      true,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': X(
      403,
      { error: 'ai:write:budgeted requires positive buzzBudget claim', code: 'context_binding' },
      false,
      []
    ),
    'rate limited': X(429, { message: 'Rate limit exceeded, please retry shortly.' }, true, [
      'checkBlockCatalogRateLimit("bki_char")',
    ]),
    'hub OAuth token': X(401, { message: 'invalid block token' }, true, []),
  },
  'src/pages/api/v1/blocks/workflows/submit.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, []),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, []),
    'non-JWT bearer (OAuth tokens off)': X(401, { error: 'Block token required' }, false, []),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: ai:write:budgeted', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': X(
      401,
      { message: 'workflow submit requires authenticated viewer' },
      true,
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': X(
      403,
      { error: 'ai:write:budgeted requires positive buzzBudget claim', code: 'context_binding' },
      false,
      []
    ),
    'rate limited': PASSED(true, []),
    'hub OAuth token': X(401, { message: 'invalid block token' }, true, []),
  },
  'src/pages/api/v1/models/[id].ts': {
    'no bearer': PASSED(false, []),
    'wrong method, no bearer': PASSED(false, []),
    'non-JWT bearer (OAuth tokens off)': PASSED(false, []),
    'runtime flag off, valid JWT': PASSED(false, []),
    'bad JWT': X(401, { error: 'invalid block token' }, false, []),
    revoked: X(403, { error: 'block instance revoked', code: 'instance_revoked' }, false, []),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      []
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      []
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: models:read:self', code: 'insufficient_scope' },
      false,
      []
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      []
    ),
    'anonymous subject': PASSED(true, []),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, []),
    'rate limited': PASSED(true, []),
    'hub OAuth token': X(
      403,
      { error: 'models:read:self bound to different modelId', code: 'context_binding' },
      false,
      []
    ),
  },
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('withBlockScope REST routes — characterisation table', () => {
  it('covers EXACTLY the set of route files that call withBlockScope(', () => {
    const root = process.cwd();
    const derived = walk(path.join(root, 'src/pages'))
      .filter((f) => /\bwithBlockScope\(/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(root, f).split(path.sep).join('/'))
      .sort();
    // Positive control on the derivation itself: it must find a known route, so an empty
    // walk (wrong cwd, wrong root) cannot read as "the table covers everything".
    expect(derived).toContain('src/pages/api/v1/blocks/me.ts');
    expect(derived).toEqual(Object.keys(ROUTES).sort());
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(ROUTES).sort());
  });

  it('every route row has exactly one expectation per cell', () => {
    for (const [file, cells] of Object.entries(EXPECTED)) {
      expect(Object.keys(cells).sort(), file).toEqual(Object.keys(CELLS).sort());
    }
  });

  for (const file of Object.keys(ROUTES)) {
    for (const cell of Object.keys(CELLS) as CellName[]) {
      it(`${file} — ${cell}`, async () => {
        const want = EXPECTED[file]?.[cell];
        expect(want, 'no expectation for this cell').toBeDefined();
        const got = await CELLS[cell](file);
        if (want.kind === 'exact') {
          const { kind: _kind, ...exact } = want;
          expect(got).toEqual(exact);
        } else {
          expect({ admitted: got.admitted, limiter: got.limiter }).toEqual({
            admitted: want.admitted,
            limiter: want.limiter,
          });
          expect(
            REFUSAL_STATUSES,
            `refused with ${got.status}: ${JSON.stringify(got.body)}`
          ).not.toContain(got.status);
        }
      });
    }
  }
});
