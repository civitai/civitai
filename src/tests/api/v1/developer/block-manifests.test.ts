import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Handler-level coverage for POST /api/v1/developer/block-manifests.
 *
 * Focused on the H-1 status-reset invariant and the M1 trust-tier lockdown:
 *  - Any manifest update lands at status='pending' (re-enters moderation)
 *  - Publisher-supplied trustTier/renderMode are ignored on INSERT
 *  - Existing trustTier/renderMode are preserved on UPDATE (separate
 *    pre-upsert check 403s on attempted change)
 */

const { mockDbRead, mockDbWrite, mockValidator } = vi.hoisted(() => {
  const dbRead = {
    oauthClient: { findUnique: vi.fn() },
    appBlock: { findUnique: vi.fn() },
  };
  const dbWrite = {
    appBlock: { upsert: vi.fn() },
  };
  const validator = { validate: vi.fn(() => ({ valid: true })) };
  return { mockDbRead: dbRead, mockDbWrite: dbWrite, mockValidator: validator };
});

vi.mock('~/env/server', () => ({
  env: { JOB_TOKEN: 'job-secret', BLOCK_TOKEN_PRIVATE_KEY: 'x', BLOCK_TOKEN_PUBLIC_KEY: 'x' },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));
vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: vi.fn(async () => true),
}));
vi.mock('~/server/services/block-manifest-validator.service', () => ({
  BlockManifestValidator: mockValidator,
}));

function makeReq(opts: { method?: string; body?: unknown; token?: string }): NextApiRequest {
  return {
    method: opts.method ?? 'POST',
    headers: { 'x-civitai-internal-token': opts.token ?? 'job-secret' },
    body: opts.body,
  } as unknown as NextApiRequest;
}

function makeRes(): NextApiResponse & { _status: number; _body: unknown } {
  const res: NextApiResponse & { _status: number; _body: unknown } = {
    _status: 0,
    _body: null,
    status: vi.fn(function (this: typeof res, n: number) {
      this._status = n;
      return this;
    }),
    json: vi.fn(function (this: typeof res, body: unknown) {
      this._body = body;
      return this;
    }),
    end: vi.fn(function (this: typeof res) {
      return this;
    }),
  } as unknown as NextApiResponse & { _status: number; _body: unknown };
  return res;
}

const VALID_BODY = {
  appId: 'app_test',
  manifest: {
    blockId: 'blk_test',
    version: '1.0.0',
    name: 'Test Block',
    contentRating: 'g',
    scopes: ['models:read:self'],
    iframe: { src: 'https://blocks.civitai.com/test', minHeight: 200, sandbox: 'allow-scripts' },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockValidator.validate.mockReturnValue({ valid: true });
  mockDbRead.oauthClient.findUnique.mockResolvedValue({
    allowedScopes: 0xffffff,
    allowedOrigins: ['https://blocks.civitai.com'],
  });
  mockDbRead.appBlock.findUnique.mockResolvedValue(null);
  mockDbWrite.appBlock.upsert.mockResolvedValue({ id: 'ab_new', status: 'pending' });
});

describe('POST /api/v1/developer/block-manifests', () => {
  it('H-1: update branch sets status=pending (re-enters moderation)', async () => {
    mockDbRead.appBlock.findUnique.mockResolvedValue({
      id: 'ab_existing',
      manifest: { something: 'old' },
      status: 'approved',
      trustTier: 'unverified',
      renderMode: 'iframe',
    });
    const { default: handler } = await import('~/pages/api/v1/developer/block-manifests');
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res._status).toBe(200);
    const upsertArgs = mockDbWrite.appBlock.upsert.mock.calls.at(-1)?.[0] as {
      update: { status?: string };
    };
    expect(upsertArgs.update.status).toBe('pending');
  });

  it('M1: trustTier supplied in manifest is IGNORED on INSERT (forced unverified)', async () => {
    const { default: handler } = await import('~/pages/api/v1/developer/block-manifests');
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          ...VALID_BODY,
          manifest: { ...VALID_BODY.manifest, trustTier: 'internal' },
        },
      }),
      res
    );
    expect(res._status).toBe(200);
    const upsertArgs = mockDbWrite.appBlock.upsert.mock.calls.at(-1)?.[0] as {
      create: { trustTier?: string; renderMode?: string };
    };
    expect(upsertArgs.create.trustTier).toBe('unverified');
    expect(upsertArgs.create.renderMode).toBe('iframe');
  });

  it('M1: renderMode supplied in manifest is IGNORED on INSERT (forced iframe)', async () => {
    const { default: handler } = await import('~/pages/api/v1/developer/block-manifests');
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          ...VALID_BODY,
          manifest: { ...VALID_BODY.manifest, renderMode: 'inline', trustTier: 'verified' },
        },
      }),
      res
    );
    expect(res._status).toBe(200);
    const upsertArgs = mockDbWrite.appBlock.upsert.mock.calls.at(-1)?.[0] as {
      create: { trustTier?: string; renderMode?: string };
    };
    expect(upsertArgs.create.renderMode).toBe('iframe');
    expect(upsertArgs.create.trustTier).toBe('unverified');
  });
});
