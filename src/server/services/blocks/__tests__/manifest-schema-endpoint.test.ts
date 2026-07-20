import { readFileSync } from 'fs';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /api/blocks/manifest-schema single-source guard.
 *
 * The endpoint MUST serve the canonical `public/schemas/app-block/v1.json`
 * verbatim (it `import`s that same file), so it can never drift back into a
 * hand-built object that understates the contract. These tests assert:
 *   1. the served body deep-equals the on-disk canonical file, and
 *   2. the CORS + public-cache headers (from the PublicEndpoint wrapper) are set.
 *
 * endpoint-helpers reads env + the db client at module load, so we mock the same
 * minimal surface the sibling block-manifests handler test mocks. withAxiom is
 * stubbed to identity so the raw handler runs.
 */
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));
vi.mock('~/env/server', () => ({
  env: {
    JOB_TOKEN: 'x',
    WEBHOOK_TOKEN: 'x',
    NEXTAUTH_URL: undefined,
    TRPC_ORIGINS: [],
    LOGGING: [],
  },
}));
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
// Cut the heavy subtrees endpoint-helpers pulls at module load (redis/logging via
// the orchestrator token, and the server-host list) — none are exercised by the
// PublicEndpoint GET path under test.
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(),
}));
vi.mock('~/server/utils/server-domain', () => ({ getAllServerHosts: () => [] }));

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const CANONICAL_PATH = path.join(REPO_ROOT, 'public/schemas/app-block/v1.json');

function makeReq(): NextApiRequest {
  return { method: 'GET', url: '/api/blocks/manifest-schema', query: {}, headers: {} } as unknown as NextApiRequest;
}

function makeRes(): NextApiResponse & { _status: number; _body: unknown; _headers: Record<string, unknown> } {
  const res = {
    _status: 0,
    _body: null as unknown,
    _headers: {} as Record<string, unknown>,
    status: vi.fn(function (this: typeof res, n: number) {
      this._status = n;
      return this;
    }),
    json: vi.fn(function (this: typeof res, body: unknown) {
      this._body = body;
      return this;
    }),
    setHeader: vi.fn(function (this: typeof res, k: string, v: unknown) {
      this._headers[k] = v;
      return this;
    }),
    end: vi.fn(function (this: typeof res) {
      return this;
    }),
  };
  return res as unknown as NextApiResponse & {
    _status: number;
    _body: unknown;
    _headers: Record<string, unknown>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/blocks/manifest-schema', () => {
  it('serves the canonical public/schemas/app-block/v1.json verbatim', async () => {
    const canonical = JSON.parse(readFileSync(CANONICAL_PATH, 'utf8'));
    const { default: handler } = await import('~/pages/api/blocks/manifest-schema');
    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status).toBe(200);
    // Deep-equality against the on-disk canonical: the endpoint can never drift
    // from the single source of truth again.
    expect(res._body).toEqual(canonical);
    // The served body carries the canonical `$id` (schemas/app-block/v1.json),
    // not the old `/api/blocks/manifest-schema` identity — the endpoint is now a
    // CORS alias for the canonical document.
    expect((res._body as { $id: string }).$id).toBe('https://civitai.com/schemas/app-block/v1.json');
  });

  it('sets CORS + public-cache headers', async () => {
    const { default: handler } = await import('~/pages/api/blocks/manifest-schema');
    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._headers['Access-Control-Allow-Origin']).toBe('*');
    expect(res._headers['Access-Control-Allow-Methods']).toBe('GET');
    expect(res._headers['Access-Control-Allow-Headers']).toBe('*');
    expect(String(res._headers['Cache-Control'])).toContain('public');
    expect(String(res._headers['Cache-Control'])).toContain('s-maxage=');
  });
});
