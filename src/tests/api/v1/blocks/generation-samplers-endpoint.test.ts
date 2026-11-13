import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * GET /api/v1/blocks/generation-samplers — the route's wiring and its wire CONTRACT.
 *
 * `withBlockScope` is a passthrough here that stamps `req.blockClaims` and records the options
 * it was given: the real token path is pinned per cell in
 * `block-token-auth.characterisation.rest.test.ts`, which cannot pin this route's 200 body
 * (it is the whole catalog), so the body is pinned here instead. The catalog is NOT mocked —
 * the route must serve what the generation graph says.
 */

const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };
const { capturedOpts } = vi.hoisted(() => ({ capturedOpts: [] as unknown[] }));

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (handler: any, opts: unknown) => {
    capturedOpts.push(opts);
    return (req: any, res: any) => {
      req.blockClaims = claimsBox.claims;
      return handler(req, res);
    };
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (handler: any) => handler }));

function fakeClaims(): BlockTokenClaims {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:42',
    iat: 0,
    exp: 0,
    jti: 'jti',
    blockId: 'blk',
    appId: 'app',
    appBlockId: 'apb_test',
    blockInstanceId: 'bki_test',
    ctx: {},
    scopes: [],
  } as unknown as BlockTokenClaims;
}

function fakeRes() {
  const res: any = {
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
    setHeader() {
      return this;
    },
  };
  return res as NextApiResponse & { statusCode?: number; body?: any };
}

async function invoke(method: string) {
  const mod = await import('~/pages/api/v1/blocks/generation-samplers');
  const handler = mod.default as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
  const req = {
    method,
    query: {},
    headers: {},
    url: '/api/v1/blocks/generation-samplers',
  } as unknown as NextApiRequest;
  const res = fakeRes();
  await handler(req, res);
  return res;
}

beforeEach(() => {
  claimsBox.claims = fakeClaims();
});

describe('GET /api/v1/blocks/generation-samplers', () => {
  it('is wrapped as an any-token, opaque-origin, serve-on-lookup-failure READ_PUBLIC route', async () => {
    await invoke('GET');
    expect(capturedOpts).toHaveLength(1);
    // Exact object: no requiredScope (so no new scope for apps to declare), its own metric label.
    expect(capturedOpts[0]).toEqual({
      endpoint: 'generation_samplers',
      allowOpaqueOrigin: true,
      onApprovalLookupFailure: 'serve',
    });
  });

  it('refuses a request the middleware passed through without claims', async () => {
    claimsBox.claims = undefined;
    const res = await invoke('GET');
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Block token required' });
  });

  it('refuses any method but GET', async () => {
    const res = await invoke('POST');
    expect(res.statusCode).toBe(405);
  });

  it('serves the catalog: per family { sampler, byModelVersion }, plus the baseModels index', async () => {
    const res = await invoke('GET');
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      ecosystems: Record<string, { sampler: unknown; byModelVersion: Record<string, unknown> }>;
      baseModels: Record<string, string>;
    };
    expect(Object.keys(body).sort()).toEqual(['baseModels', 'ecosystems']);

    // Literal contract for one family of each answer kind (the full set is pinned in
    // src/shared/generation/__tests__/sampler-options.test.ts).
    expect(body.ecosystems.SDXL).toEqual({
      sampler: {
        options: ['Euler a', 'Euler', 'Heun', 'LMS', 'DDIM', 'DPM++ 2M Karras', 'DPM2', 'DPM2 a'].map(
          (v) => ({ value: v, label: v })
        ),
        default: 'Euler a',
      },
      byModelVersion: {},
    });
    expect(body.ecosystems.Flux1).toEqual({ sampler: null, byModelVersion: {} });
    expect(body.baseModels['SDXL 1.0']).toBe('SDXL');

    // Shape of every family, so a client can rely on it without special cases.
    for (const [eco, family] of Object.entries(body.ecosystems)) {
      expect(Object.keys(family).sort(), eco).toEqual(['byModelVersion', 'sampler']);
      for (const choice of [family.sampler, ...Object.values(family.byModelVersion)]) {
        if (choice === null) continue;
        const c = choice as { options: { value: string; label: string }[]; default: string };
        expect(Object.keys(c).sort(), eco).toEqual(['default', 'options']);
        expect(c.options.length, eco).toBeGreaterThan(0);
        for (const o of c.options) {
          expect(Object.keys(o).sort(), eco).toEqual(['label', 'value']);
          expect(typeof o.value).toBe('string');
          expect(typeof o.label).toBe('string');
        }
        expect(c.options.map((o) => o.value), eco).toContain(c.default);
      }
    }

    // It survives JSON — what a block actually receives.
    expect(JSON.parse(JSON.stringify(body))).toEqual(body);
  });
});
