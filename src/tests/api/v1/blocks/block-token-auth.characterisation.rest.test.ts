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
import type * as GenerationService from '~/server/services/generation/generation.service';

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
 * auth path, not the feature). Every cell is pinned verbatim — status, body, admitted, limiter
 * calls and `reached` (the apps-db sentinel and the generation-resources lookup) — EXCEPT a
 * downstream artefact (a 500/502, or a 503 `ok:false` money-path answer from an unconfigured
 * network call), which is PASSED: admitted, limiter calls and `reached` pinned, body not, and
 * the status must not be a refusal.
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
  reached: [] as string[],
  flagBase: { on: false },
}));

/**
 * Per-user flag answers: on for the token subject only, the base value (default off) for a
 * no-user evaluation. A flag evaluated for the wrong identity — or none — answers differently.
 */
function subjectFlag() {
  return async (opts?: { user?: { id?: number } }) =>
    opts?.user ? opts.user.id === 42 : h.flagBase.on;
}

vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof AppBlocksFlag>()),
  isAppBlocksRuntimeEnabled: async () => h.runtimeFlag.on,
  isAppBlocksEnabled: subjectFlag(),
  isAppBlocksSharedStorageEnabled: subjectFlag(),
  // Pinned OFF so the one route that consults the authoring capability answers the same
  // way on every machine, rather than whatever the flag client resolves to locally.
  isAppBlocksAuthorEnabled: async () => false,
}));
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: { isRevoked: (...a: unknown[]) => h.isRevoked(...a) },
}));
vi.mock('~/server/services/blocks/consent-revocation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ConsentRevocationModule>()),
  ConsentRevocation: {
    lookup: (opts: unknown) => {
      h.reached.push(`consent-lookup:${JSON.stringify(opts)}`);
      return h.consentLookup(opts);
    },
  },
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
/**
 * POSITIVE ANCHORS for requests that get past auth: the apps-db pool is a sentinel that records
 * the visit and stops there, and `getResourceData` (generation-resources' only downstream call,
 * which otherwise waits ~15 s on an unreachable dependency) records its ids and answers empty.
 */
vi.mock('~/server/db/appsDb', () => ({
  requireAppsDb: () => {
    h.reached.push('apps-db');
    throw new Error('PAST_AUTH: reached the apps-db pool');
  },
}));
vi.mock('~/server/services/generation/generation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerationService>()),
  getResourceData: async (ids: number[]) => {
    h.reached.push(`getResourceData(${JSON.stringify(ids)})`);
    return [];
  },
}));
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
  query?: Record<string, string | string[]>;
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
  // The document store's one catch-all, driven as a single-document read. The fixture row has
  // no manifest, so an admitted request declares no collection and answers 404 after the read
  // bucket is charged.
  'src/pages/api/v1/blocks/storage/[[...path]].ts': {
    load: () => import('~/pages/api/v1/blocks/storage/[[...path]]'),
    method: 'GET',
    query: { path: ['prefs', 'k'] },
    scope: 'apps:storage',
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

async function mint(over: {
  scopes: string[];
  anon?: boolean;
  buzzBudget?: number;
  dev?: boolean;
  privateRun?: boolean;
}) {
  const { token } = await BlockTokenService.sign({
    userId: over.anon ? null : SUBJECT_ID,
    blockId: 'char-block',
    appId: 'app_char',
    // Distinct from the approval row's id (`apb_row`), so a cell can tell which one a bucket
    // or a read was keyed on.
    appBlockId: 'apb_claim',
    blockInstanceId: 'bki_char',
    scopes: over.scopes,
    ctx: { modelId: 7, slotId: 'model.sidebar_top' },
    maxBrowsingLevel: 1,
    ...(over.buzzBudget === undefined ? { buzzBudget: 100 } : { buzzBudget: over.buzzBudget }),
    ...(over.dev ? { dev: true } : {}),
    ...(over.privateRun ? { privateRun: true, privateRunAudience: 'owner' } : {}),
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

type Response = {
  status: number;
  body: unknown;
  admitted: boolean;
  limiter: string[];
  /**
   * Positive anchors and identity-bearing reads, in order: consent-marker lookups (with their
   * arguments), session hydrations (by user id), the apps-db pool sentinel, the
   * generation-resources lookup.
   */
  reached: string[];
  /** The scopes on the claims withBlockScope handed the wrapped handler (null if not admitted). */
  handlerScopes: string[] | null;
};

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
  h.reached.length = 0;
  try {
    await handler(req, res as unknown as NextApiResponse);
  } catch (err) {
    return {
      status: -1,
      body: { thrown: (err as Error)?.constructor?.name, message: (err as Error)?.message },
      admitted: req.blockClaims !== undefined,
      limiter: [...h.limiterCalls],
      reached: [...h.reached],
      handlerScopes: handlerScopes(req),
    };
  }
  return {
    status: res.statusCode,
    body: res.body,
    admitted: req.blockClaims !== undefined,
    limiter: [...h.limiterCalls],
    reached: [...h.reached],
    handlerScopes: handlerScopes(req),
  };
}

function handlerScopes(req: { blockClaims?: unknown }): string[] | null {
  const c = req.blockClaims as { scopes?: string[] } | undefined;
  return c ? [...(c.scopes ?? [])] : null;
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
  h.flagBase.on = false;
  h.isRevoked.mockReset().mockResolvedValue(false);
  h.consentLookup.mockReset().mockResolvedValue({ kind: 'none' });
  h.getActiveDevTunnel.mockReset().mockResolvedValue(null);
  h.getSessionUserById.mockReset().mockImplementation(async (id: number) => {
    h.reached.push(`hydrate:${id}`);
    return id === SUBJECT_ID ? { ...TRUSTED_SUBJECT } : null;
  });
  h.getSessionFromBearerToken.mockReset().mockResolvedValue(null);
  dbMock.dbRead.appBlock.findUnique.mockReset().mockResolvedValue({
    id: 'apb_row',
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
  | 'hub OAuth token'
  | 'missing approval row'
  | 'approval row read throws'
  | 'consent revoked for the route scope'
  | 'consent marker unavailable'
  | 'consent marker unavailable AND not approved'
  | 'dev token, no approval row'
  | 'private-run token, row not approved';

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
    dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ id: 'apb_row', status: 'suspended' });
    return call(f, { authorization: `Bearer ${await mint({ scopes: scopesFor(f) })}` });
  },
  'revoked AND not approved': async (f) => {
    h.isRevoked.mockResolvedValue(true);
    dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ id: 'apb_row', status: 'suspended' });
    return call(f, { authorization: `Bearer ${await mint({ scopes: scopesFor(f) })}` });
  },
  'missing scope': async (f) => call(f, { authorization: `Bearer ${await mint({ scopes: [] })}` }),
  'token carries an unknown scope': async (f) =>
    call(f, {
      authorization: `Bearer ${await mint({ scopes: [...scopesFor(f), 'made:up:scope'] })}`,
    }),
  // Flags base-enabled (the GA shape) so an anon subject passes the flag and the cell pins the
  // middleware's and the route's own anonymous handling.
  'anonymous subject': async (f) => {
    h.flagBase.on = true;
    return call(f, { authorization: `Bearer ${await mint({ scopes: scopesFor(f), anon: true })}` });
  },
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
      id: 'apb_hubrow',
      blockId: 'char-block',
      manifest: { scopes: scopesFor(f) },
      approvedScopes: scopesFor(f),
    });
    return call(f, { authorization: 'Bearer hub-oauth-access-token' });
  },
  // ── the approval verdicts REST treats differently from the bridge ──
  'missing approval row': async (f) => {
    dbMock.dbRead.appBlock.findUnique.mockResolvedValue(null);
    return call(f, { authorization: `Bearer ${await mint({ scopes: scopesFor(f) })}` });
  },
  'approval row read throws': async (f) => {
    dbMock.dbRead.appBlock.findUnique.mockRejectedValue(new Error('replica unreachable'));
    return call(f, { authorization: `Bearer ${await mint({ scopes: scopesFor(f) })}` });
  },
  // ── consent: the token also carries a consent-GATED scope, so the marker is consulted on
  // every scoped route; whether the ROUTE's own scope is revokable decides the outcome ──
  'consent revoked for the route scope': async (f) => {
    h.consentLookup.mockResolvedValue({
      kind: 'revoked',
      scopes: new Set([...scopesFor(f), CONSENT_GATED]),
    });
    return call(f, { authorization: `Bearer ${await mint({ scopes: consentScopes(f) })}` });
  },
  'consent marker unavailable': async (f) => {
    h.consentLookup.mockResolvedValue({ kind: 'unavailable' });
    return call(f, { authorization: `Bearer ${await mint({ scopes: consentScopes(f) })}` });
  },
  // Pins REST's ORDER: the consent read is answered BEFORE the approval row.
  'consent marker unavailable AND not approved': async (f) => {
    h.consentLookup.mockResolvedValue({ kind: 'unavailable' });
    dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ id: 'apb_row', status: 'suspended' });
    return call(f, { authorization: `Bearer ${await mint({ scopes: consentScopes(f) })}` });
  },
  // ── the exempt token populations ──
  'dev token, no approval row': async (f) => {
    dbMock.dbRead.appBlock.findUnique.mockResolvedValue(null);
    return call(f, {
      authorization: `Bearer ${await mint({ scopes: scopesFor(f), dev: true })}`,
    });
  },
  'private-run token, row not approved': async (f) => {
    dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ id: 'apb_row', status: 'suspended' });
    return call(f, {
      authorization: `Bearer ${await mint({ scopes: scopesFor(f), privateRun: true })}`,
    });
  },
};

/** A consent-gated scope (not in the exempt set), carried so the marker is consulted. */
const CONSENT_GATED = 'buzz:read:self';
function consentScopes(file: string): string[] {
  return [...new Set([...scopesFor(file), CONSENT_GATED])];
}

function scopesFor(file: string): string[] {
  const s = ROUTES[file].scope;
  return s ? [s] : [];
}

// ── expectations ─────────────────────────────────────────────────────────────────────────

/**
 * A response pinned verbatim: status, body, whether the middleware admitted it, limiter calls,
 * and the positive anchors reached.
 */
type Exact = { kind: 'exact' } & Response;
/**
 * The handler answered past auth with a DOWNSTREAM ARTEFACT — a 500/502, or a 503 `ok:false`
 * money-path answer, produced by a network call or service this file does not configure. Its
 * body is not pinned. Pinned instead: whether the middleware admitted it, the limiter calls,
 * the positive anchors reached, and that the status is NOT a refusal (401/403/405/429).
 */
type Passed = {
  kind: 'passed';
  admitted: boolean;
  limiter: string[];
  reached: string[];
  handlerScopes: string[] | null;
};

const X = (
  status: number,
  body: unknown,
  admitted: boolean,
  limiter: string[],
  reached: string[],
  handlerScopes: string[] | null
): Exact => ({ kind: 'exact', status, body, admitted, limiter, reached, handlerScopes });
const PASSED = (
  admitted: boolean,
  limiter: string[],
  reached: string[],
  handlerScopes: string[] | null
): Passed => ({ kind: 'passed', admitted, limiter, reached, handlerScopes });
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
 *   - `missing approval row` / `dev token, no approval row`: the middleware SERVES (admitted —
 *     REST's deliberate difference from the bridge); app-storage and shared-storage routes then
 *     refuse in their own second resolver (`app block not found`).
 *   - `approval row read throws`: 503 `app block status unavailable`, except on the five routes
 *     declaring `onApprovalLookupFailure: 'serve'` (generation-resources, images, models, tools,
 *     models/[id]), which are admitted.
 *   - `consent …`: the token carries a consent-gated scope, so the marker is consulted on every
 *     scoped route. A revoked/unavailable marker refuses only routes whose OWN scope is
 *     revokable (403 `consent_revoked` / 503 `permission_state_unavailable`); routes whose
 *     scope is consent-exempt are served with the gated scope stripped.
 *   - `consent marker unavailable AND not approved`: the 503 wins on revokable-scope routes —
 *     REST answers the consent read BEFORE the approval row (the bridge does the opposite).
 *   - `private-run token, row not approved`: admitted by the middleware; the storage and shared
 *     resolvers then refuse it (`app block is not approved`).
 *   - `rate limited`: the limiter is stubbed to refuse. `poll` and `cancel` answer a
 *     NON-TERMINAL 200 snapshot by design instead of a 429.
 */
const EXPECTED: Record<string, Record<CellName, Exact | Passed>> = {
  'src/pages/api/v1/blocks/app-storage/delete.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:write', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      403,
      { error: 'apps:storage:write requires authenticated subject', code: 'context_binding' },
      false,
      [],
      [],
      null
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(
      true,
      [],
      ['hydrate:42', 'apps-db'],
      ['apps:storage:write']
    ),
    'rate limited': PASSED(true, [], ['hydrate:42', 'apps-db'], ['apps:storage:write']),
    'hub OAuth token': X(
      401,
      { message: 'invalid block token' },
      true,
      [],
      [],
      ['apps:storage:write']
    ),
    'missing approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:write']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:write']
    ),
    'consent marker unavailable': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:write']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:write']
    ),
    'private-run token, row not approved': X(
      403,
      { message: 'app block is not approved' },
      true,
      [],
      [],
      ['apps:storage:write']
    ),
  },
  'src/pages/api/v1/blocks/app-storage/get.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:read', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      403,
      { error: 'apps:storage:read requires authenticated subject', code: 'context_binding' },
      false,
      [],
      [],
      null
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(
      true,
      [],
      ['hydrate:42', 'apps-db'],
      ['apps:storage:read']
    ),
    'rate limited': PASSED(true, [], ['hydrate:42', 'apps-db'], ['apps:storage:read']),
    'hub OAuth token': X(
      401,
      { message: 'invalid block token' },
      true,
      [],
      [],
      ['apps:storage:read']
    ),
    'missing approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:read']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:read']
    ),
    'consent marker unavailable': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:read']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:read']
    ),
    'private-run token, row not approved': X(
      403,
      { message: 'app block is not approved' },
      true,
      [],
      [],
      ['apps:storage:read']
    ),
  },
  'src/pages/api/v1/blocks/app-storage/list.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:read', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      403,
      { error: 'apps:storage:read requires authenticated subject', code: 'context_binding' },
      false,
      [],
      [],
      null
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(
      true,
      [],
      ['hydrate:42', 'apps-db'],
      ['apps:storage:read']
    ),
    'rate limited': PASSED(true, [], ['hydrate:42', 'apps-db'], ['apps:storage:read']),
    'hub OAuth token': X(
      401,
      { message: 'invalid block token' },
      true,
      [],
      [],
      ['apps:storage:read']
    ),
    'missing approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:read']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:read']
    ),
    'consent marker unavailable': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:read']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:read']
    ),
    'private-run token, row not approved': X(
      403,
      { message: 'app block is not approved' },
      true,
      [],
      [],
      ['apps:storage:read']
    ),
  },
  'src/pages/api/v1/blocks/app-storage/quota.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:read', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      403,
      { error: 'apps:storage:read requires authenticated subject', code: 'context_binding' },
      false,
      [],
      [],
      null
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(
      true,
      [],
      ['hydrate:42', 'apps-db'],
      ['apps:storage:read']
    ),
    'rate limited': PASSED(true, [], ['hydrate:42', 'apps-db'], ['apps:storage:read']),
    'hub OAuth token': X(
      401,
      { message: 'invalid block token' },
      true,
      [],
      [],
      ['apps:storage:read']
    ),
    'missing approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:read']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:read']
    ),
    'consent marker unavailable': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:read']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:read']
    ),
    'private-run token, row not approved': X(
      403,
      { message: 'app block is not approved' },
      true,
      [],
      [],
      ['apps:storage:read']
    ),
  },
  'src/pages/api/v1/blocks/app-storage/set.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:write', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      403,
      { error: 'apps:storage:write requires authenticated subject', code: 'context_binding' },
      false,
      [],
      [],
      null
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(
      true,
      [],
      ['hydrate:42', 'apps-db'],
      ['apps:storage:write']
    ),
    'rate limited': PASSED(true, [], ['hydrate:42', 'apps-db'], ['apps:storage:write']),
    'hub OAuth token': X(
      401,
      { message: 'invalid block token' },
      true,
      [],
      [],
      ['apps:storage:write']
    ),
    'missing approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:write']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:write']
    ),
    'consent marker unavailable': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:write']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:write']
    ),
    'private-run token, row not approved': X(
      403,
      { message: 'app block is not approved' },
      true,
      [],
      [],
      ['apps:storage:write']
    ),
  },
  'src/pages/api/v1/blocks/buzz.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: buzz:read:self', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      403,
      { error: 'buzz:read:self requires authenticated subject', code: 'context_binding' },
      false,
      [],
      [],
      null
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['buzz:read:self']
    ),
    'rate limited': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['buzz:read:self']
    ),
    'hub OAuth token': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_hubrow"}'],
      ['buzz:read:self']
    ),
    'missing approval row': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['buzz:read:self']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent revoked for the route scope': X(
      403,
      { error: 'consent revoked for scope: buzz:read:self', code: 'consent_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent marker unavailable': X(
      503,
      {
        error: 'permission state is temporarily unavailable — retry shortly',
        code: 'permission_state_unavailable',
      },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent marker unavailable AND not approved': X(
      503,
      {
        error: 'permission state is temporarily unavailable — retry shortly',
        code: 'permission_state_unavailable',
      },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['buzz:read:self']
    ),
    'private-run token, row not approved': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['buzz:read:self']
    ),
  },
  'src/pages/api/v1/blocks/collections/[id]/follow.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: collections:write:self', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      403,
      { error: 'collections:write:self requires authenticated subject', code: 'context_binding' },
      false,
      [],
      [],
      null
    ),
    'ai:write:budgeted without a positive buzzBudget': X(
      401,
      { error: 'You do not have permission to add contributors to this collection.' },
      true,
      [],
      [],
      ['collections:write:self']
    ),
    'rate limited': X(
      401,
      { error: 'You do not have permission to add contributors to this collection.' },
      true,
      [],
      [],
      ['collections:write:self']
    ),
    'hub OAuth token': X(
      401,
      { error: 'You do not have permission to add contributors to this collection.' },
      true,
      [],
      [],
      ['collections:write:self']
    ),
    'missing approval row': X(
      401,
      { error: 'You do not have permission to add contributors to this collection.' },
      true,
      [],
      [],
      ['collections:write:self']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': X(
      401,
      { error: 'You do not have permission to add contributors to this collection.' },
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['collections:write:self']
    ),
    'consent marker unavailable': X(
      401,
      { error: 'You do not have permission to add contributors to this collection.' },
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['collections:write:self']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      401,
      { error: 'You do not have permission to add contributors to this collection.' },
      true,
      [],
      [],
      ['collections:write:self']
    ),
    'private-run token, row not approved': X(
      401,
      { error: 'You do not have permission to add contributors to this collection.' },
      true,
      [],
      [],
      ['collections:write:self']
    ),
  },
  'src/pages/api/v1/blocks/collections/[id]/index.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: collections:read:self', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      403,
      { error: 'collections:read:self requires authenticated subject', code: 'context_binding' },
      false,
      [],
      [],
      null
    ),
    'ai:write:budgeted without a positive buzzBudget': X(
      404,
      { error: 'Collection not found' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['hydrate:42'],
      ['collections:read:self']
    ),
    'rate limited': X(
      429,
      { error: 'Rate limit exceeded, please retry shortly.' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [],
      ['collections:read:self']
    ),
    'hub OAuth token': X(
      404,
      { error: 'Collection not found' },
      true,
      ['checkBlockCatalogRateLimit("page_apb_hubrow")'],
      ['hydrate:42'],
      ['collections:read:self']
    ),
    'missing approval row': X(
      404,
      { error: 'Collection not found' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['hydrate:42'],
      ['collections:read:self']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': X(
      404,
      { error: 'Collection not found' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42'],
      ['collections:read:self']
    ),
    'consent marker unavailable': X(
      404,
      { error: 'Collection not found' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42'],
      ['collections:read:self']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      404,
      { error: 'Collection not found' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['hydrate:42'],
      ['collections:read:self']
    ),
    'private-run token, row not approved': X(
      404,
      { error: 'Collection not found' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['hydrate:42'],
      ['collections:read:self']
    ),
  },
  'src/pages/api/v1/blocks/collections/index.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: collections:read:self', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      403,
      { error: 'collections:read:self requires authenticated subject', code: 'context_binding' },
      false,
      [],
      [],
      null
    ),
    'ai:write:budgeted without a positive buzzBudget': X(
      200,
      { items: [] },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['hydrate:42'],
      ['collections:read:self']
    ),
    'rate limited': X(
      429,
      { error: 'Rate limit exceeded, please retry shortly.' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [],
      ['collections:read:self']
    ),
    'hub OAuth token': X(
      200,
      { items: [] },
      true,
      ['checkBlockCatalogRateLimit("page_apb_hubrow")'],
      ['hydrate:42'],
      ['collections:read:self']
    ),
    'missing approval row': X(
      200,
      { items: [] },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['hydrate:42'],
      ['collections:read:self']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': X(
      200,
      { items: [] },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42'],
      ['collections:read:self']
    ),
    'consent marker unavailable': X(
      200,
      { items: [] },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42'],
      ['collections:read:self']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      200,
      { items: [] },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['hydrate:42'],
      ['collections:read:self']
    ),
    'private-run token, row not approved': X(
      200,
      { items: [] },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['hydrate:42'],
      ['collections:read:self']
    ),
  },
  'src/pages/api/v1/blocks/entitlements.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: goods:read:self', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      403,
      { error: 'goods:read:self requires authenticated subject', code: 'context_binding' },
      false,
      [],
      [],
      null
    ),
    'ai:write:budgeted without a positive buzzBudget': X(
      200,
      { entitlements: [] },
      true,
      ['checkBlockGoodReadRateLimit("bki_char", 42)'],
      [],
      ['goods:read:self']
    ),
    'rate limited': X(
      429,
      { error: 'Rate limit exceeded, please retry shortly.' },
      true,
      ['checkBlockGoodReadRateLimit("bki_char", 42)'],
      [],
      ['goods:read:self']
    ),
    'hub OAuth token': X(
      200,
      { entitlements: [] },
      true,
      ['checkBlockGoodReadRateLimit("page_apb_hubrow", 42)'],
      [],
      ['goods:read:self']
    ),
    'missing approval row': X(
      200,
      { entitlements: [] },
      true,
      ['checkBlockGoodReadRateLimit("bki_char", 42)'],
      [],
      ['goods:read:self']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': X(
      200,
      { entitlements: [] },
      true,
      ['checkBlockGoodReadRateLimit("bki_char", 42)'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['goods:read:self']
    ),
    'consent marker unavailable': X(
      200,
      { entitlements: [] },
      true,
      ['checkBlockGoodReadRateLimit("bki_char", 42)'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['goods:read:self']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      200,
      { entitlements: [] },
      true,
      ['checkBlockGoodReadRateLimit("bki_char", 42)'],
      [],
      ['goods:read:self']
    ),
    'private-run token, row not approved': X(
      200,
      { entitlements: [] },
      true,
      ['checkBlockGoodReadRateLimit("bki_char", 42)'],
      [],
      ['goods:read:self']
    ),
  },
  'src/pages/api/v1/blocks/gated-images.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      200,
      { images: [] },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['hydrate:42'],
      []
    ),
    'token carries an unknown scope': X(
      200,
      { images: [] },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['hydrate:42'],
      ['made:up:scope']
    ),
    'anonymous subject': X(
      401,
      { message: 'gated image read requires an authenticated viewer' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [],
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': X(
      200,
      { images: [] },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['hydrate:42'],
      []
    ),
    'rate limited': X(
      429,
      { error: 'Rate limit exceeded, please retry shortly.' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [],
      []
    ),
    'hub OAuth token': X(
      200,
      { images: [] },
      true,
      ['checkBlockCatalogRateLimit("page_apb_hubrow")'],
      ['hydrate:42'],
      []
    ),
    'missing approval row': X(
      200,
      { images: [] },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['hydrate:42'],
      []
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': X(
      200,
      { images: [] },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['hydrate:42'],
      ['buzz:read:self']
    ),
    'consent marker unavailable': X(
      200,
      { images: [] },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['hydrate:42'],
      ['buzz:read:self']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'dev token, no approval row': X(
      200,
      { images: [] },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['hydrate:42'],
      []
    ),
    'private-run token, row not approved': X(
      200,
      { images: [] },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['hydrate:42'],
      []
    ),
  },
  'src/pages/api/v1/blocks/generation-resources.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      200,
      { items: [], maturity: { browsingLevel: 1, sfwOnly: true } },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['getResourceData([1])'],
      []
    ),
    'token carries an unknown scope': X(
      200,
      { items: [], maturity: { browsingLevel: 1, sfwOnly: true } },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['getResourceData([1])'],
      ['made:up:scope']
    ),
    'anonymous subject': X(
      200,
      { items: [], maturity: { browsingLevel: 1, sfwOnly: true } },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['getResourceData([1])'],
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': X(
      200,
      { items: [], maturity: { browsingLevel: 1, sfwOnly: true } },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['getResourceData([1])'],
      []
    ),
    'rate limited': X(
      429,
      { error: 'Rate limit exceeded, please retry shortly.' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [],
      []
    ),
    'hub OAuth token': X(
      200,
      { items: [], maturity: { browsingLevel: 3, sfwOnly: true } },
      true,
      ['checkBlockCatalogRateLimit("page_apb_hubrow")'],
      ['getResourceData([1])'],
      []
    ),
    'missing approval row': X(
      200,
      { items: [], maturity: { browsingLevel: 1, sfwOnly: true } },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['getResourceData([1])'],
      []
    ),
    'approval row read throws': X(
      200,
      { items: [], maturity: { browsingLevel: 1, sfwOnly: true } },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['getResourceData([1])'],
      []
    ),
    'consent revoked for the route scope': X(
      200,
      { items: [], maturity: { browsingLevel: 1, sfwOnly: true } },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['getResourceData([1])'],
      ['buzz:read:self']
    ),
    'consent marker unavailable': X(
      200,
      { items: [], maturity: { browsingLevel: 1, sfwOnly: true } },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['getResourceData([1])'],
      ['buzz:read:self']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'dev token, no approval row': X(
      200,
      { items: [], maturity: { browsingLevel: 1, sfwOnly: true } },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['getResourceData([1])'],
      []
    ),
    'private-run token, row not approved': X(
      200,
      { items: [], maturity: { browsingLevel: 1, sfwOnly: true } },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['getResourceData([1])'],
      []
    ),
  },
  'src/pages/api/v1/blocks/goods/purchase.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: goods:purchase:self', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      403,
      { error: 'goods:purchase:self requires authenticated subject', code: 'context_binding' },
      false,
      [],
      [],
      null
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(
      true,
      ['checkBlockGoodRateLimit("bki_char", 42)'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['goods:purchase:self']
    ),
    'rate limited': X(
      429,
      { error: 'Too many purchases — please retry shortly.' },
      true,
      ['checkBlockGoodRateLimit("bki_char", 42)'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['goods:purchase:self']
    ),
    'hub OAuth token': PASSED(
      true,
      ['checkBlockGoodRateLimit("page_apb_hubrow", 42)'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_hubrow"}'],
      ['goods:purchase:self']
    ),
    'missing approval row': PASSED(
      true,
      ['checkBlockGoodRateLimit("bki_char", 42)'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['goods:purchase:self']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent revoked for the route scope': X(
      403,
      { error: 'consent revoked for scope: goods:purchase:self', code: 'consent_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent marker unavailable': X(
      503,
      {
        error: 'permission state is temporarily unavailable — retry shortly',
        code: 'permission_state_unavailable',
      },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent marker unavailable AND not approved': X(
      503,
      {
        error: 'permission state is temporarily unavailable — retry shortly',
        code: 'permission_state_unavailable',
      },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': PASSED(
      true,
      ['checkBlockGoodRateLimit("bki_char", 42)'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['goods:purchase:self']
    ),
    'private-run token, row not approved': PASSED(
      true,
      ['checkBlockGoodRateLimit("bki_char", 42)'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['goods:purchase:self']
    ),
  },
  'src/pages/api/v1/blocks/images.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")'], [], []),
    'token carries an unknown scope': PASSED(
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [],
      ['made:up:scope']
    ),
    'anonymous subject': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")'], [], []),
    'ai:write:budgeted without a positive buzzBudget': PASSED(
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [],
      []
    ),
    'rate limited': X(
      429,
      { error: 'Rate limit exceeded, please retry shortly.' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [],
      []
    ),
    'hub OAuth token': PASSED(true, ['checkBlockCatalogRateLimit("page_apb_hubrow")'], [], []),
    'missing approval row': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")'], [], []),
    'approval row read throws': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")'], [], []),
    'consent revoked for the route scope': PASSED(
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [],
      ['buzz:read:self']
    ),
    'consent marker unavailable': PASSED(
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [],
      ['buzz:read:self']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'dev token, no approval row': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")'], [], []),
    'private-run token, row not approved': PASSED(
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [],
      []
    ),
  },
  'src/pages/api/v1/blocks/me.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: user:read:self', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      403,
      { error: 'user:read:self requires authenticated subject', code: 'context_binding' },
      false,
      [],
      [],
      null
    ),
    'ai:write:budgeted without a positive buzzBudget': X(
      404,
      { error: 'User not found' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42'],
      ['user:read:self']
    ),
    'rate limited': X(
      429,
      { error: 'Rate limit exceeded, please retry shortly.' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42'],
      ['user:read:self']
    ),
    'hub OAuth token': X(
      404,
      { error: 'User not found' },
      true,
      ['checkBlockCatalogRateLimit("page_apb_hubrow")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_hubrow"}', 'hydrate:42'],
      ['user:read:self']
    ),
    'missing approval row': X(
      404,
      { error: 'User not found' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42'],
      ['user:read:self']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent revoked for the route scope': X(
      403,
      { error: 'consent revoked for scope: user:read:self', code: 'consent_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent marker unavailable': X(
      503,
      {
        error: 'permission state is temporarily unavailable — retry shortly',
        code: 'permission_state_unavailable',
      },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent marker unavailable AND not approved': X(
      503,
      {
        error: 'permission state is temporarily unavailable — retry shortly',
        code: 'permission_state_unavailable',
      },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      404,
      { error: 'User not found' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42'],
      ['user:read:self']
    ),
    'private-run token, row not approved': X(
      404,
      { error: 'User not found' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42'],
      ['user:read:self']
    ),
  },
  'src/pages/api/v1/blocks/models.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")'], [], []),
    'token carries an unknown scope': PASSED(
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [],
      ['made:up:scope']
    ),
    'anonymous subject': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")'], [], []),
    'ai:write:budgeted without a positive buzzBudget': PASSED(
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [],
      []
    ),
    'rate limited': X(
      429,
      { error: 'Rate limit exceeded, please retry shortly.' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [],
      []
    ),
    'hub OAuth token': PASSED(true, ['checkBlockCatalogRateLimit("page_apb_hubrow")'], [], []),
    'missing approval row': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")'], [], []),
    'approval row read throws': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")'], [], []),
    'consent revoked for the route scope': PASSED(
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [],
      ['buzz:read:self']
    ),
    'consent marker unavailable': PASSED(
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [],
      ['buzz:read:self']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'dev token, no approval row': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")'], [], []),
    'private-run token, row not approved': PASSED(
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [],
      []
    ),
  },
  'src/pages/api/v1/blocks/resource-intent.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      200,
      {
        degraded: true,
        insightFallback: false,
        intent: null,
        criteria: null,
        suggestions: [],
        noneProbability: null,
        model: 'jev-unavailable',
        criteriaVersion: 2,
        maturity: { browsingLevel: 1, sfwOnly: true },
      },
      true,
      ['checkBlockLLMRateLimit("bki_char")'],
      [],
      []
    ),
    'token carries an unknown scope': X(
      200,
      {
        degraded: true,
        insightFallback: false,
        intent: null,
        criteria: null,
        suggestions: [],
        noneProbability: null,
        model: 'jev-unavailable',
        criteriaVersion: 2,
        maturity: { browsingLevel: 1, sfwOnly: true },
      },
      true,
      ['checkBlockLLMRateLimit("bki_char")'],
      [],
      ['made:up:scope']
    ),
    'anonymous subject': X(
      200,
      {
        degraded: true,
        insightFallback: false,
        intent: null,
        criteria: null,
        suggestions: [],
        noneProbability: null,
        model: 'jev-unavailable',
        criteriaVersion: 2,
        maturity: { browsingLevel: 1, sfwOnly: true },
      },
      true,
      ['checkBlockLLMRateLimit("bki_char")'],
      [],
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': X(
      200,
      {
        degraded: true,
        insightFallback: false,
        intent: null,
        criteria: null,
        suggestions: [],
        noneProbability: null,
        model: 'jev-unavailable',
        criteriaVersion: 2,
        maturity: { browsingLevel: 1, sfwOnly: true },
      },
      true,
      ['checkBlockLLMRateLimit("bki_char")'],
      [],
      []
    ),
    'rate limited': X(
      429,
      { error: 'Rate limit exceeded, please retry shortly.' },
      true,
      ['checkBlockLLMRateLimit("bki_char")'],
      [],
      []
    ),
    'hub OAuth token': X(
      200,
      {
        degraded: true,
        insightFallback: false,
        intent: null,
        criteria: null,
        suggestions: [],
        noneProbability: null,
        model: 'jev-unavailable',
        criteriaVersion: 2,
        maturity: { browsingLevel: 3, sfwOnly: true },
      },
      true,
      ['checkBlockLLMRateLimit("page_apb_hubrow")'],
      [],
      []
    ),
    'missing approval row': X(
      200,
      {
        degraded: true,
        insightFallback: false,
        intent: null,
        criteria: null,
        suggestions: [],
        noneProbability: null,
        model: 'jev-unavailable',
        criteriaVersion: 2,
        maturity: { browsingLevel: 1, sfwOnly: true },
      },
      true,
      ['checkBlockLLMRateLimit("bki_char")'],
      [],
      []
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': X(
      200,
      {
        degraded: true,
        insightFallback: false,
        intent: null,
        criteria: null,
        suggestions: [],
        noneProbability: null,
        model: 'jev-unavailable',
        criteriaVersion: 2,
        maturity: { browsingLevel: 1, sfwOnly: true },
      },
      true,
      ['checkBlockLLMRateLimit("bki_char")'],
      [],
      ['buzz:read:self']
    ),
    'consent marker unavailable': X(
      200,
      {
        degraded: true,
        insightFallback: false,
        intent: null,
        criteria: null,
        suggestions: [],
        noneProbability: null,
        model: 'jev-unavailable',
        criteriaVersion: 2,
        maturity: { browsingLevel: 1, sfwOnly: true },
      },
      true,
      ['checkBlockLLMRateLimit("bki_char")'],
      [],
      ['buzz:read:self']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'dev token, no approval row': X(
      200,
      {
        degraded: true,
        insightFallback: false,
        intent: null,
        criteria: null,
        suggestions: [],
        noneProbability: null,
        model: 'jev-unavailable',
        criteriaVersion: 2,
        maturity: { browsingLevel: 1, sfwOnly: true },
      },
      true,
      ['checkBlockLLMRateLimit("bki_char")'],
      [],
      []
    ),
    'private-run token, row not approved': X(
      200,
      {
        degraded: true,
        insightFallback: false,
        intent: null,
        criteria: null,
        suggestions: [],
        noneProbability: null,
        model: 'jev-unavailable',
        criteriaVersion: 2,
        maturity: { browsingLevel: 1, sfwOnly: true },
      },
      true,
      ['checkBlockLLMRateLimit("bki_char")'],
      [],
      []
    ),
  },
  'src/pages/api/v1/blocks/shared-storage/append.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:shared:write', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      403,
      {
        error: 'apps:storage:shared:write requires authenticated subject',
        code: 'context_binding',
      },
      false,
      [],
      [],
      null
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(
      true,
      ['reserveSharedWrite(42, "apb_row")'],
      ['hydrate:42', 'apps-db'],
      ['apps:storage:shared:write']
    ),
    'rate limited': X(
      429,
      {
        error: 'Too many submissions — retry in 7s',
        message: 'Too many submissions — retry in 7s',
        code: 'TOO_MANY_REQUESTS',
        rateLimit: { retryAfterSeconds: 7, retryAt: '2026-01-01T00:00:07.000Z' },
      },
      true,
      ['reserveSharedWrite(42, "apb_row")'],
      ['hydrate:42'],
      ['apps:storage:shared:write']
    ),
    'hub OAuth token': X(
      401,
      { message: 'invalid block token' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
    'missing approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': PASSED(
      true,
      ['reserveSharedWrite(42, "apb_row")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:shared:write']
    ),
    'consent marker unavailable': PASSED(
      true,
      ['reserveSharedWrite(42, "apb_row")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:shared:write']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
    'private-run token, row not approved': X(
      403,
      { message: 'app block is not approved' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
  },
  'src/pages/api/v1/blocks/shared-storage/counts.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:shared:read', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': PASSED(true, [], ['apps-db'], ['apps:storage:shared:read']),
    'ai:write:budgeted without a positive buzzBudget': PASSED(
      true,
      [],
      ['hydrate:42', 'apps-db'],
      ['apps:storage:shared:read']
    ),
    'rate limited': PASSED(true, [], ['hydrate:42', 'apps-db'], ['apps:storage:shared:read']),
    'hub OAuth token': X(
      401,
      { message: 'invalid block token' },
      true,
      [],
      [],
      ['apps:storage:shared:read']
    ),
    'missing approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:shared:read']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:shared:read']
    ),
    'consent marker unavailable': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:shared:read']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:shared:read']
    ),
    'private-run token, row not approved': X(
      403,
      { message: 'app block is not approved' },
      true,
      [],
      [],
      ['apps:storage:shared:read']
    ),
  },
  'src/pages/api/v1/blocks/shared-storage/increment.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:shared:write', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      403,
      {
        error: 'apps:storage:shared:write requires authenticated subject',
        code: 'context_binding',
      },
      false,
      [],
      [],
      null
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(
      true,
      ['checkSharedVoteRateLimit(42, "apb_row")'],
      ['hydrate:42', 'apps-db'],
      ['apps:storage:shared:write']
    ),
    'rate limited': X(
      429,
      {
        error: 'Too many increments — retry in 7s',
        message: 'Too many increments — retry in 7s',
        code: 'TOO_MANY_REQUESTS',
        rateLimit: { retryAfterSeconds: 7, retryAt: '2026-01-01T00:00:07.000Z' },
      },
      true,
      ['checkSharedVoteRateLimit(42, "apb_row")'],
      ['hydrate:42'],
      ['apps:storage:shared:write']
    ),
    'hub OAuth token': X(
      401,
      { error: 'invalid block token' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
    'missing approval row': X(
      404,
      { error: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': PASSED(
      true,
      ['checkSharedVoteRateLimit(42, "apb_row")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:shared:write']
    ),
    'consent marker unavailable': PASSED(
      true,
      ['checkSharedVoteRateLimit(42, "apb_row")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:shared:write']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      404,
      { error: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
    'private-run token, row not approved': X(
      403,
      { error: 'app block is not approved' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
  },
  'src/pages/api/v1/blocks/shared-storage/item.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:shared:read', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': PASSED(true, [], ['apps-db'], ['apps:storage:shared:read']),
    'ai:write:budgeted without a positive buzzBudget': PASSED(
      true,
      [],
      ['hydrate:42', 'apps-db'],
      ['apps:storage:shared:read']
    ),
    'rate limited': PASSED(true, [], ['hydrate:42', 'apps-db'], ['apps:storage:shared:read']),
    'hub OAuth token': X(
      401,
      { message: 'invalid block token' },
      true,
      [],
      [],
      ['apps:storage:shared:read']
    ),
    'missing approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:shared:read']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:shared:read']
    ),
    'consent marker unavailable': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:shared:read']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:shared:read']
    ),
    'private-run token, row not approved': X(
      403,
      { message: 'app block is not approved' },
      true,
      [],
      [],
      ['apps:storage:shared:read']
    ),
  },
  'src/pages/api/v1/blocks/shared-storage/list.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:shared:read', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': PASSED(true, [], ['apps-db'], ['apps:storage:shared:read']),
    'ai:write:budgeted without a positive buzzBudget': PASSED(
      true,
      [],
      ['hydrate:42', 'apps-db'],
      ['apps:storage:shared:read']
    ),
    'rate limited': PASSED(true, [], ['hydrate:42', 'apps-db'], ['apps:storage:shared:read']),
    'hub OAuth token': X(
      401,
      { message: 'invalid block token' },
      true,
      [],
      [],
      ['apps:storage:shared:read']
    ),
    'missing approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:shared:read']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:shared:read']
    ),
    'consent marker unavailable': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:shared:read']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:shared:read']
    ),
    'private-run token, row not approved': X(
      403,
      { message: 'app block is not approved' },
      true,
      [],
      [],
      ['apps:storage:shared:read']
    ),
  },
  'src/pages/api/v1/blocks/shared-storage/report.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:shared:write', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      403,
      {
        error: 'apps:storage:shared:write requires authenticated subject',
        code: 'context_binding',
      },
      false,
      [],
      [],
      null
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(
      true,
      ['checkSharedReportRateLimit(42, "apb_row")'],
      ['hydrate:42', 'apps-db'],
      ['apps:storage:shared:write']
    ),
    'rate limited': X(
      429,
      {
        error: 'Too many reports — retry in 7s',
        message: 'Too many reports — retry in 7s',
        code: 'TOO_MANY_REQUESTS',
        rateLimit: { retryAfterSeconds: 7, retryAt: '2026-01-01T00:00:07.000Z' },
      },
      true,
      ['checkSharedReportRateLimit(42, "apb_row")'],
      ['hydrate:42'],
      ['apps:storage:shared:write']
    ),
    'hub OAuth token': X(
      401,
      { message: 'invalid block token' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
    'missing approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': PASSED(
      true,
      ['checkSharedReportRateLimit(42, "apb_row")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:shared:write']
    ),
    'consent marker unavailable': PASSED(
      true,
      ['checkSharedReportRateLimit(42, "apb_row")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:shared:write']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
    'private-run token, row not approved': X(
      403,
      { message: 'app block is not approved' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
  },
  'src/pages/api/v1/blocks/shared-storage/top.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:shared:read', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': PASSED(true, [], ['apps-db'], ['apps:storage:shared:read']),
    'ai:write:budgeted without a positive buzzBudget': PASSED(
      true,
      [],
      ['hydrate:42', 'apps-db'],
      ['apps:storage:shared:read']
    ),
    'rate limited': PASSED(true, [], ['hydrate:42', 'apps-db'], ['apps:storage:shared:read']),
    'hub OAuth token': X(
      401,
      { error: 'invalid block token' },
      true,
      [],
      [],
      ['apps:storage:shared:read']
    ),
    'missing approval row': X(
      404,
      { error: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:shared:read']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:shared:read']
    ),
    'consent marker unavailable': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:shared:read']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      404,
      { error: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:shared:read']
    ),
    'private-run token, row not approved': X(
      403,
      { error: 'app block is not approved' },
      true,
      [],
      [],
      ['apps:storage:shared:read']
    ),
  },
  'src/pages/api/v1/blocks/shared-storage/unvote.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:shared:write', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      403,
      {
        error: 'apps:storage:shared:write requires authenticated subject',
        code: 'context_binding',
      },
      false,
      [],
      [],
      null
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(
      true,
      ['checkSharedVoteRateLimit(42, "apb_row")'],
      ['hydrate:42', 'apps-db'],
      ['apps:storage:shared:write']
    ),
    'rate limited': X(
      429,
      {
        error: 'Too many votes — retry in 7s',
        message: 'Too many votes — retry in 7s',
        code: 'TOO_MANY_REQUESTS',
        rateLimit: { retryAfterSeconds: 7, retryAt: '2026-01-01T00:00:07.000Z' },
      },
      true,
      ['checkSharedVoteRateLimit(42, "apb_row")'],
      ['hydrate:42'],
      ['apps:storage:shared:write']
    ),
    'hub OAuth token': X(
      401,
      { message: 'invalid block token' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
    'missing approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': PASSED(
      true,
      ['checkSharedVoteRateLimit(42, "apb_row")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:shared:write']
    ),
    'consent marker unavailable': PASSED(
      true,
      ['checkSharedVoteRateLimit(42, "apb_row")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:shared:write']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
    'private-run token, row not approved': X(
      403,
      { message: 'app block is not approved' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
  },
  'src/pages/api/v1/blocks/shared-storage/update.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:shared:write', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      403,
      {
        error: 'apps:storage:shared:write requires authenticated subject',
        code: 'context_binding',
      },
      false,
      [],
      [],
      null
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(
      true,
      ['reserveSharedWrite(42, "apb_row")'],
      ['hydrate:42', 'apps-db'],
      ['apps:storage:shared:write']
    ),
    'rate limited': X(
      429,
      {
        error: 'Too many submissions — retry in 7s',
        message: 'Too many submissions — retry in 7s',
        code: 'TOO_MANY_REQUESTS',
        rateLimit: { retryAfterSeconds: 7, retryAt: '2026-01-01T00:00:07.000Z' },
      },
      true,
      ['reserveSharedWrite(42, "apb_row")'],
      ['hydrate:42'],
      ['apps:storage:shared:write']
    ),
    'hub OAuth token': X(
      401,
      { message: 'invalid block token' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
    'missing approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': PASSED(
      true,
      ['reserveSharedWrite(42, "apb_row")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:shared:write']
    ),
    'consent marker unavailable': PASSED(
      true,
      ['reserveSharedWrite(42, "apb_row")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:shared:write']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
    'private-run token, row not approved': X(
      403,
      { message: 'app block is not approved' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
  },
  'src/pages/api/v1/blocks/shared-storage/vote.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:shared:write', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      403,
      {
        error: 'apps:storage:shared:write requires authenticated subject',
        code: 'context_binding',
      },
      false,
      [],
      [],
      null
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(
      true,
      ['checkSharedVoteRateLimit(42, "apb_row")'],
      ['hydrate:42', 'apps-db'],
      ['apps:storage:shared:write']
    ),
    'rate limited': X(
      429,
      {
        error: 'Too many votes — retry in 7s',
        message: 'Too many votes — retry in 7s',
        code: 'TOO_MANY_REQUESTS',
        rateLimit: { retryAfterSeconds: 7, retryAt: '2026-01-01T00:00:07.000Z' },
      },
      true,
      ['checkSharedVoteRateLimit(42, "apb_row")'],
      ['hydrate:42'],
      ['apps:storage:shared:write']
    ),
    'hub OAuth token': X(
      401,
      { message: 'invalid block token' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
    'missing approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': PASSED(
      true,
      ['checkSharedVoteRateLimit(42, "apb_row")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:shared:write']
    ),
    'consent marker unavailable': PASSED(
      true,
      ['checkSharedVoteRateLimit(42, "apb_row")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:shared:write']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
    'private-run token, row not approved': X(
      403,
      { message: 'app block is not approved' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
  },
  'src/pages/api/v1/blocks/shared-storage/withdraw.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:storage:shared:write', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      403,
      {
        error: 'apps:storage:shared:write requires authenticated subject',
        code: 'context_binding',
      },
      false,
      [],
      [],
      null
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(
      true,
      ['checkSharedWithdrawRateLimit(42, "apb_row")'],
      ['hydrate:42', 'apps-db'],
      ['apps:storage:shared:write']
    ),
    'rate limited': X(
      429,
      {
        error: 'Too many withdrawals — retry in 7s',
        message: 'Too many withdrawals — retry in 7s',
        code: 'TOO_MANY_REQUESTS',
        rateLimit: { retryAfterSeconds: 7, retryAt: '2026-01-01T00:00:07.000Z' },
      },
      true,
      ['checkSharedWithdrawRateLimit(42, "apb_row")'],
      ['hydrate:42'],
      ['apps:storage:shared:write']
    ),
    'hub OAuth token': X(
      401,
      { message: 'invalid block token' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
    'missing approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': PASSED(
      true,
      ['checkSharedWithdrawRateLimit(42, "apb_row")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:shared:write']
    ),
    'consent marker unavailable': PASSED(
      true,
      ['checkSharedWithdrawRateLimit(42, "apb_row")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'apps-db'],
      ['apps:storage:shared:write']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
    'private-run token, row not approved': X(
      403,
      { message: 'app block is not approved' },
      true,
      [],
      [],
      ['apps:storage:shared:write']
    ),
  },
  'src/pages/api/v1/blocks/sub-listings/mine.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:store:items:write', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      403,
      { error: 'apps:store:items:write requires authenticated subject', code: 'context_binding' },
      false,
      [],
      [],
      null
    ),
    'ai:write:budgeted without a positive buzzBudget': X(
      200,
      { items: [] },
      true,
      [],
      [],
      ['apps:store:items:write']
    ),
    'rate limited': X(200, { items: [] }, true, [], [], ['apps:store:items:write']),
    'hub OAuth token': X(200, { items: [] }, true, [], [], ['apps:store:items:write']),
    'missing approval row': X(200, { items: [] }, true, [], [], ['apps:store:items:write']),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': X(
      200,
      { items: [] },
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['apps:store:items:write']
    ),
    'consent marker unavailable': X(
      200,
      { items: [] },
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['apps:store:items:write']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(200, { items: [] }, true, [], [], ['apps:store:items:write']),
    'private-run token, row not approved': X(
      200,
      { items: [] },
      true,
      [],
      [],
      ['apps:store:items:write']
    ),
  },
  'src/pages/api/v1/blocks/sub-listings/upsert.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:store:items:write', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      403,
      { error: 'apps:store:items:write requires authenticated subject', code: 'context_binding' },
      false,
      [],
      [],
      null
    ),
    'ai:write:budgeted without a positive buzzBudget': X(
      400,
      { error: 'Invalid request body', code: 'invalid_body' },
      true,
      [],
      ['hydrate:42'],
      ['apps:store:items:write']
    ),
    'rate limited': X(
      400,
      { error: 'Invalid request body', code: 'invalid_body' },
      true,
      [],
      ['hydrate:42'],
      ['apps:store:items:write']
    ),
    'hub OAuth token': X(
      400,
      { error: 'Invalid request body', code: 'invalid_body' },
      true,
      [],
      ['hydrate:42'],
      ['apps:store:items:write']
    ),
    'missing approval row': X(
      400,
      { error: 'Invalid request body', code: 'invalid_body' },
      true,
      [],
      ['hydrate:42'],
      ['apps:store:items:write']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': X(
      400,
      { error: 'Invalid request body', code: 'invalid_body' },
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42'],
      ['apps:store:items:write']
    ),
    'consent marker unavailable': X(
      400,
      { error: 'Invalid request body', code: 'invalid_body' },
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42'],
      ['apps:store:items:write']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      400,
      { error: 'Invalid request body', code: 'invalid_body' },
      true,
      [],
      ['hydrate:42'],
      ['apps:store:items:write']
    ),
    'private-run token, row not approved': X(
      400,
      { error: 'Invalid request body', code: 'invalid_body' },
      true,
      [],
      ['hydrate:42'],
      ['apps:store:items:write']
    ),
  },
  'src/pages/api/v1/blocks/sub-listings/withdraw.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: apps:store:items:write', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      403,
      { error: 'apps:store:items:write requires authenticated subject', code: 'context_binding' },
      false,
      [],
      [],
      null
    ),
    'ai:write:budgeted without a positive buzzBudget': X(
      400,
      { error: 'Invalid request body', code: 'invalid_body' },
      true,
      [],
      [],
      ['apps:store:items:write']
    ),
    'rate limited': X(
      400,
      { error: 'Invalid request body', code: 'invalid_body' },
      true,
      [],
      [],
      ['apps:store:items:write']
    ),
    'hub OAuth token': X(
      400,
      { error: 'Invalid request body', code: 'invalid_body' },
      true,
      [],
      [],
      ['apps:store:items:write']
    ),
    'missing approval row': X(
      400,
      { error: 'Invalid request body', code: 'invalid_body' },
      true,
      [],
      [],
      ['apps:store:items:write']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': X(
      400,
      { error: 'Invalid request body', code: 'invalid_body' },
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['apps:store:items:write']
    ),
    'consent marker unavailable': X(
      400,
      { error: 'Invalid request body', code: 'invalid_body' },
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['apps:store:items:write']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      400,
      { error: 'Invalid request body', code: 'invalid_body' },
      true,
      [],
      [],
      ['apps:store:items:write']
    ),
    'private-run token, row not approved': X(
      400,
      { error: 'Invalid request body', code: 'invalid_body' },
      true,
      [],
      [],
      ['apps:store:items:write']
    ),
  },
  'src/pages/api/v1/blocks/tip-allowance.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: social:tip:self', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      403,
      { error: 'social:tip:self requires authenticated subject', code: 'context_binding' },
      false,
      [],
      [],
      null
    ),
    'ai:write:budgeted without a positive buzzBudget': X(
      200,
      { cap: 25000, spent: 0, remaining: 25000 },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['social:tip:self']
    ),
    'rate limited': X(
      429,
      { error: 'Rate limit exceeded, please retry shortly.' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['social:tip:self']
    ),
    'hub OAuth token': X(
      200,
      { cap: 25000, spent: 0, remaining: 25000 },
      true,
      ['checkBlockCatalogRateLimit("page_apb_hubrow")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_hubrow"}'],
      ['social:tip:self']
    ),
    'missing approval row': X(
      200,
      { cap: 25000, spent: 0, remaining: 25000 },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['social:tip:self']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent revoked for the route scope': X(
      403,
      { error: 'consent revoked for scope: social:tip:self', code: 'consent_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent marker unavailable': X(
      503,
      {
        error: 'permission state is temporarily unavailable — retry shortly',
        code: 'permission_state_unavailable',
      },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent marker unavailable AND not approved': X(
      503,
      {
        error: 'permission state is temporarily unavailable — retry shortly',
        code: 'permission_state_unavailable',
      },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      200,
      { cap: 25000, spent: 0, remaining: 25000 },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['social:tip:self']
    ),
    'private-run token, row not approved': X(
      200,
      { cap: 25000, spent: 0, remaining: 25000 },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['social:tip:self']
    ),
  },
  'src/pages/api/v1/blocks/tip.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: social:tip:self', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      403,
      { error: 'social:tip:self requires authenticated subject', code: 'context_binding' },
      false,
      [],
      [],
      null
    ),
    'ai:write:budgeted without a positive buzzBudget': PASSED(
      true,
      ['checkBlockTipRateLimit("bki_char")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42'],
      ['social:tip:self']
    ),
    'rate limited': X(
      429,
      { error: 'Too many tips — please retry shortly.' },
      true,
      ['checkBlockTipRateLimit("bki_char")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['social:tip:self']
    ),
    'hub OAuth token': PASSED(
      true,
      ['checkBlockTipRateLimit("page_apb_hubrow")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_hubrow"}', 'hydrate:42'],
      ['social:tip:self']
    ),
    'missing approval row': PASSED(
      true,
      ['checkBlockTipRateLimit("bki_char")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42'],
      ['social:tip:self']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent revoked for the route scope': X(
      403,
      { error: 'consent revoked for scope: social:tip:self', code: 'consent_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent marker unavailable': X(
      503,
      {
        error: 'permission state is temporarily unavailable — retry shortly',
        code: 'permission_state_unavailable',
      },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent marker unavailable AND not approved': X(
      503,
      {
        error: 'permission state is temporarily unavailable — retry shortly',
        code: 'permission_state_unavailable',
      },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': PASSED(
      true,
      ['checkBlockTipRateLimit("bki_char")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42'],
      ['social:tip:self']
    ),
    'private-run token, row not approved': PASSED(
      true,
      ['checkBlockTipRateLimit("bki_char")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42'],
      ['social:tip:self']
    ),
  },
  'src/pages/api/v1/blocks/tools.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")'], [], []),
    'token carries an unknown scope': PASSED(
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [],
      ['made:up:scope']
    ),
    'anonymous subject': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")'], [], []),
    'ai:write:budgeted without a positive buzzBudget': PASSED(
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [],
      []
    ),
    'rate limited': X(
      429,
      { error: 'Rate limit exceeded, please retry shortly.' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [],
      []
    ),
    'hub OAuth token': PASSED(true, ['checkBlockCatalogRateLimit("page_apb_hubrow")'], [], []),
    'missing approval row': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")'], [], []),
    'approval row read throws': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")'], [], []),
    'consent revoked for the route scope': PASSED(
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [],
      ['buzz:read:self']
    ),
    'consent marker unavailable': PASSED(
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [],
      ['buzz:read:self']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'dev token, no approval row': PASSED(true, ['checkBlockCatalogRateLimit("bki_char")'], [], []),
    'private-run token, row not approved': PASSED(
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [],
      []
    ),
  },
  'src/pages/api/v1/blocks/storage/[[...path]].ts': {
    'no bearer': X(
      401,
      {
        code: 'unauthenticated',
        message: 'a block token is required',
        error: 'a block token is required',
      },
      false,
      [],
      [],
      null
    ),
    'wrong method, no bearer': X(
      401,
      {
        code: 'unauthenticated',
        message: 'a block token is required',
        error: 'a block token is required',
      },
      false,
      [],
      [],
      null
    ),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      {
        code: 'unauthenticated',
        message: 'a block token is required',
        error: 'a block token is required',
      },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(
      401,
      {
        code: 'unauthenticated',
        message: 'a block token is required',
        error: 'a block token is required',
      },
      false,
      [],
      [],
      null
    ),
    'bad JWT': X(
      401,
      { code: 'unauthenticated', message: 'invalid block token', error: 'invalid block token' },
      false,
      [],
      [],
      null
    ),
    revoked: X(
      403,
      {
        code: 'not_eligible',
        message: 'block instance revoked',
        error: 'block instance revoked',
        details: { reason: 'instance_revoked' },
      },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      {
        code: 'not_eligible',
        message: 'app block is not approved',
        error: 'app block is not approved',
        details: { reason: 'app_not_approved' },
      },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      {
        code: 'not_eligible',
        message: 'block instance revoked',
        error: 'block instance revoked',
        details: { reason: 'instance_revoked' },
      },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      {
        code: 'insufficient_scope',
        message: 'missing required scope: apps:storage',
        error: 'missing required scope: apps:storage',
      },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      {
        code: 'not_eligible',
        message: 'unknown scope: made:up:scope',
        error: 'unknown scope: made:up:scope',
        details: { reason: 'context_binding' },
      },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      404,
      {
        code: 'collection_not_declared',
        message: 'collection prefs is not declared',
        error: 'collection prefs is not declared',
        details: { collection: 'prefs' },
      },
      true,
      ['checkDocStoreRateLimit("read", "apb_row", "ip:203.0.113.7")'],
      [],
      ['apps:storage']
    ),
    'ai:write:budgeted without a positive buzzBudget': X(
      404,
      {
        code: 'collection_not_declared',
        message: 'collection prefs is not declared',
        error: 'collection prefs is not declared',
        details: { collection: 'prefs' },
      },
      true,
      ['checkDocStoreRateLimit("read", "apb_row", "u:42")'],
      ['hydrate:42'],
      ['apps:storage']
    ),
    'rate limited': X(
      429,
      {
        code: 'rate_limited',
        message: 'rate limit exceeded',
        error: 'rate limit exceeded',
        details: { bucket: 'read', retryAfter: 7 },
        rateLimit: { retryAfterSeconds: 7, retryAt: '2026-01-01T00:00:07.000Z' },
      },
      true,
      ['checkDocStoreRateLimit("read", "apb_row", "u:42")'],
      ['hydrate:42'],
      ['apps:storage']
    ),
    'hub OAuth token': X(
      404,
      {
        code: 'collection_not_declared',
        message: 'collection prefs is not declared',
        error: 'collection prefs is not declared',
        details: { collection: 'prefs' },
      },
      true,
      ['checkDocStoreRateLimit("read", "apb_row", "u:42")'],
      ['hydrate:42'],
      ['apps:storage']
    ),
    'missing approval row': X(
      403,
      {
        code: 'not_eligible',
        message: 'app block is not approved',
        error: 'app block is not approved',
        details: { reason: 'app_not_approved' },
      },
      true,
      [],
      [],
      ['apps:storage']
    ),
    'approval row read throws': X(
      503,
      {
        code: 'service_unavailable',
        message: 'app block status unavailable',
        error: 'app block status unavailable',
      },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': X(
      404,
      {
        code: 'collection_not_declared',
        message: 'collection prefs is not declared',
        error: 'collection prefs is not declared',
        details: { collection: 'prefs' },
      },
      true,
      ['checkDocStoreRateLimit("read", "apb_row", "u:42")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42'],
      ['apps:storage']
    ),
    'consent marker unavailable': X(
      404,
      {
        code: 'collection_not_declared',
        message: 'collection prefs is not declared',
        error: 'collection prefs is not declared',
        details: { collection: 'prefs' },
      },
      true,
      ['checkDocStoreRateLimit("read", "apb_row", "u:42")'],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42'],
      ['apps:storage']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      {
        code: 'not_eligible',
        message: 'app block is not approved',
        error: 'app block is not approved',
        details: { reason: 'app_not_approved' },
      },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      403,
      {
        code: 'not_eligible',
        message: 'app block is not approved',
        error: 'app block is not approved',
        details: { reason: 'app_not_approved' },
      },
      true,
      [],
      [],
      ['apps:storage']
    ),
    'private-run token, row not approved': X(
      403,
      {
        code: 'not_eligible',
        message: 'app block is not approved',
        error: 'app block is not approved',
        details: { reason: 'app_not_approved' },
      },
      true,
      [],
      [],
      ['apps:storage']
    ),
  },
  'src/pages/api/v1/blocks/user-checkpoint/set.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      { message: 'Apps authoring is not enabled for this account' },
      true,
      [],
      ['hydrate:42', 'hydrate:42'],
      []
    ),
    'token carries an unknown scope': X(
      403,
      { message: 'Apps authoring is not enabled for this account' },
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'hydrate:42'],
      ['made:up:scope']
    ),
    'anonymous subject': X(
      401,
      { message: 'anon viewers cannot persist block settings' },
      true,
      [],
      [],
      []
    ),
    'ai:write:budgeted without a positive buzzBudget': X(
      403,
      { message: 'Apps authoring is not enabled for this account' },
      true,
      [],
      ['hydrate:42', 'hydrate:42'],
      []
    ),
    'rate limited': X(
      403,
      { message: 'Apps authoring is not enabled for this account' },
      true,
      [],
      ['hydrate:42', 'hydrate:42'],
      []
    ),
    'hub OAuth token': X(401, { message: 'invalid block token' }, true, [], [], []),
    'missing approval row': X(404, { message: 'app block not found' }, true, [], [], []),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      [],
      null
    ),
    'consent revoked for the route scope': X(
      403,
      { message: 'Apps authoring is not enabled for this account' },
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}', 'hydrate:42', 'hydrate:42'],
      ['buzz:read:self']
    ),
    'consent marker unavailable': X(
      503,
      { message: 'permission state is temporarily unavailable — retry shortly' },
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['buzz:read:self']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'dev token, no approval row': X(
      403,
      { message: 'Apps authoring is not enabled for this account' },
      true,
      [],
      ['hydrate:42', 'hydrate:42'],
      []
    ),
    'private-run token, row not approved': X(
      403,
      { message: 'Apps authoring is not enabled for this account' },
      true,
      [],
      ['hydrate:42', 'hydrate:42'],
      []
    ),
  },
  'src/pages/api/v1/blocks/workflows/cancel.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: ai:write:budgeted', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      401,
      { message: 'workflow cancel requires authenticated viewer' },
      true,
      [],
      [],
      ['ai:write:budgeted']
    ),
    'ai:write:budgeted without a positive buzzBudget': X(
      403,
      { error: 'ai:write:budgeted requires positive buzzBudget claim', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'rate limited': X(
      200,
      { snapshot: { workflowId: 'wf_1', status: 'processing' } },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'hydrate:42',
      ],
      ['ai:write:budgeted']
    ),
    'hub OAuth token': X(
      401,
      { message: 'invalid block token' },
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_hubrow"}'],
      ['ai:write:budgeted']
    ),
    'missing approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
      ],
      ['ai:write:budgeted']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent revoked for the route scope': X(
      403,
      { error: 'consent revoked for scope: ai:write:budgeted', code: 'consent_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent marker unavailable': X(
      503,
      {
        error: 'permission state is temporarily unavailable — retry shortly',
        code: 'permission_state_unavailable',
      },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent marker unavailable AND not approved': X(
      503,
      {
        error: 'permission state is temporarily unavailable — retry shortly',
        code: 'permission_state_unavailable',
      },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': PASSED(
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'hydrate:42',
      ],
      ['ai:write:budgeted']
    ),
    'private-run token, row not approved': PASSED(
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'hydrate:42',
      ],
      ['ai:write:budgeted']
    ),
  },
  'src/pages/api/v1/blocks/workflows/estimate.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: ai:write:budgeted', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      401,
      { message: 'estimate requires authenticated viewer' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [],
      ['ai:write:budgeted']
    ),
    'ai:write:budgeted without a positive buzzBudget': X(
      403,
      { error: 'ai:write:budgeted requires positive buzzBudget claim', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'rate limited': X(
      429,
      { message: 'Rate limit exceeded, please retry shortly.' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
      ],
      ['ai:write:budgeted']
    ),
    'hub OAuth token': X(
      401,
      { message: 'invalid block token' },
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_hubrow"}'],
      ['ai:write:budgeted']
    ),
    'missing approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
      ],
      ['ai:write:budgeted']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent revoked for the route scope': X(
      403,
      { error: 'consent revoked for scope: ai:write:budgeted', code: 'consent_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent marker unavailable': X(
      503,
      {
        error: 'permission state is temporarily unavailable — retry shortly',
        code: 'permission_state_unavailable',
      },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent marker unavailable AND not approved': X(
      503,
      {
        error: 'permission state is temporarily unavailable — retry shortly',
        code: 'permission_state_unavailable',
      },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      404,
      { message: 'model version not found' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'hydrate:42',
      ],
      ['ai:write:budgeted']
    ),
    'private-run token, row not approved': X(
      404,
      { message: 'model version not found' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'hydrate:42',
      ],
      ['ai:write:budgeted']
    ),
  },
  'src/pages/api/v1/blocks/workflows/poll.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: ai:write:budgeted', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      401,
      { message: 'workflow poll requires authenticated viewer' },
      true,
      [],
      [],
      ['ai:write:budgeted']
    ),
    'ai:write:budgeted without a positive buzzBudget': X(
      403,
      { error: 'ai:write:budgeted requires positive buzzBudget claim', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'rate limited': X(
      200,
      { snapshot: { workflowId: 'wf_1', status: 'processing' } },
      true,
      ['checkBlockPollRateLimit("bki_char", 42)'],
      [
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'hydrate:42',
      ],
      ['ai:write:budgeted']
    ),
    'hub OAuth token': X(
      401,
      { message: 'invalid block token' },
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_hubrow"}'],
      ['ai:write:budgeted']
    ),
    'missing approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
      ],
      ['ai:write:budgeted']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent revoked for the route scope': X(
      403,
      { error: 'consent revoked for scope: ai:write:budgeted', code: 'consent_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent marker unavailable': X(
      503,
      {
        error: 'permission state is temporarily unavailable — retry shortly',
        code: 'permission_state_unavailable',
      },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent marker unavailable AND not approved': X(
      503,
      {
        error: 'permission state is temporarily unavailable — retry shortly',
        code: 'permission_state_unavailable',
      },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': PASSED(
      true,
      ['checkBlockPollRateLimit("bki_char", 42)'],
      [
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'hydrate:42',
      ],
      ['ai:write:budgeted']
    ),
    'private-run token, row not approved': PASSED(
      true,
      ['checkBlockPollRateLimit("bki_char", 42)'],
      [
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'hydrate:42',
      ],
      ['ai:write:budgeted']
    ),
  },
  'src/pages/api/v1/blocks/workflows/query.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: ai:write:budgeted', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      401,
      { message: 'workflow query requires authenticated viewer' },
      true,
      [],
      [],
      ['ai:write:budgeted']
    ),
    'ai:write:budgeted without a positive buzzBudget': X(
      403,
      { error: 'ai:write:budgeted requires positive buzzBudget claim', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'rate limited': X(
      429,
      { message: 'Rate limit exceeded, please retry shortly.' },
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'hydrate:42',
      ],
      ['ai:write:budgeted']
    ),
    'hub OAuth token': X(
      401,
      { message: 'invalid block token' },
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_hubrow"}'],
      ['ai:write:budgeted']
    ),
    'missing approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
      ],
      ['ai:write:budgeted']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent revoked for the route scope': X(
      403,
      { error: 'consent revoked for scope: ai:write:budgeted', code: 'consent_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent marker unavailable': X(
      503,
      {
        error: 'permission state is temporarily unavailable — retry shortly',
        code: 'permission_state_unavailable',
      },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent marker unavailable AND not approved': X(
      503,
      {
        error: 'permission state is temporarily unavailable — retry shortly',
        code: 'permission_state_unavailable',
      },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': PASSED(
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'hydrate:42',
      ],
      ['ai:write:budgeted']
    ),
    'private-run token, row not approved': PASSED(
      true,
      ['checkBlockCatalogRateLimit("bki_char")'],
      [
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'hydrate:42',
      ],
      ['ai:write:budgeted']
    ),
  },
  'src/pages/api/v1/blocks/workflows/submit.ts': {
    'no bearer': X(401, { error: 'Block token required' }, false, [], [], null),
    'wrong method, no bearer': X(405, { error: 'Method not allowed' }, false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': X(
      401,
      { error: 'Block token required' },
      false,
      [],
      [],
      null
    ),
    'runtime flag off, valid JWT': X(401, { error: 'Block token required' }, false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: ai:write:budgeted', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': X(
      401,
      { message: 'workflow submit requires authenticated viewer' },
      true,
      [],
      [],
      ['ai:write:budgeted']
    ),
    'ai:write:budgeted without a positive buzzBudget': X(
      403,
      { error: 'ai:write:budgeted requires positive buzzBudget claim', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'rate limited': X(
      404,
      { message: 'model version not found' },
      true,
      [],
      [
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'hydrate:42',
      ],
      ['ai:write:budgeted']
    ),
    'hub OAuth token': X(
      401,
      { message: 'invalid block token' },
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_hubrow"}'],
      ['ai:write:budgeted']
    ),
    'missing approval row': X(
      404,
      { message: 'app block not found' },
      true,
      [],
      [
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
      ],
      ['ai:write:budgeted']
    ),
    'approval row read throws': X(
      503,
      { error: 'app block status unavailable' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent revoked for the route scope': X(
      403,
      { error: 'consent revoked for scope: ai:write:budgeted', code: 'consent_revoked' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent marker unavailable': X(
      503,
      {
        error: 'permission state is temporarily unavailable — retry shortly',
        code: 'permission_state_unavailable',
      },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'consent marker unavailable AND not approved': X(
      503,
      {
        error: 'permission state is temporarily unavailable — retry shortly',
        code: 'permission_state_unavailable',
      },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': X(
      404,
      { message: 'model version not found' },
      true,
      [],
      [
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'hydrate:42',
      ],
      ['ai:write:budgeted']
    ),
    'private-run token, row not approved': X(
      404,
      { message: 'model version not found' },
      true,
      [],
      [
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'consent-lookup:{"userId":42,"appBlockId":"apb_claim"}',
        'hydrate:42',
      ],
      ['ai:write:budgeted']
    ),
  },
  'src/pages/api/v1/models/[id].ts': {
    'no bearer': PASSED(false, [], [], null),
    'wrong method, no bearer': PASSED(false, [], [], null),
    'non-JWT bearer (OAuth tokens off)': PASSED(false, [], [], null),
    'runtime flag off, valid JWT': PASSED(false, [], [], null),
    'bad JWT': X(401, { error: 'invalid block token' }, false, [], [], null),
    revoked: X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      [],
      null
    ),
    'revoked AND not approved': X(
      403,
      { error: 'block instance revoked', code: 'instance_revoked' },
      false,
      [],
      [],
      null
    ),
    'missing scope': X(
      403,
      { error: 'missing required scope: models:read:self', code: 'insufficient_scope' },
      false,
      [],
      [],
      null
    ),
    'token carries an unknown scope': X(
      403,
      { error: 'unknown scope: made:up:scope', code: 'context_binding' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'anonymous subject': PASSED(true, [], [], ['models:read:self']),
    'ai:write:budgeted without a positive buzzBudget': PASSED(true, [], [], ['models:read:self']),
    'rate limited': PASSED(true, [], [], ['models:read:self']),
    'hub OAuth token': X(
      403,
      { error: 'models:read:self bound to different modelId', code: 'context_binding' },
      false,
      [],
      [],
      null
    ),
    'missing approval row': PASSED(true, [], [], ['models:read:self']),
    'approval row read throws': PASSED(true, [], [], ['models:read:self']),
    'consent revoked for the route scope': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['models:read:self']
    ),
    'consent marker unavailable': PASSED(
      true,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      ['models:read:self']
    ),
    'consent marker unavailable AND not approved': X(
      403,
      { error: 'app block is not approved', code: 'app_not_approved' },
      false,
      [],
      ['consent-lookup:{"userId":42,"appBlockId":"apb_claim"}'],
      null
    ),
    'dev token, no approval row': PASSED(true, [], [], ['models:read:self']),
    'private-run token, row not approved': PASSED(true, [], [], ['models:read:self']),
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
          expect({
            admitted: got.admitted,
            limiter: got.limiter,
            reached: got.reached,
            handlerScopes: got.handlerScopes,
          }).toEqual({
            admitted: want.admitted,
            limiter: want.limiter,
            reached: want.reached,
            handlerScopes: want.handlerScopes,
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
