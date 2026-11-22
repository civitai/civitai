import { Prisma } from '@prisma/client';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

/**
 * Handler-level coverage for POST /api/v1/developer/block-manifests.
 *
 * Focused on the H-1 status-reset invariant and the M1 trust-tier lockdown:
 *  - Any manifest update lands at status='pending' (re-enters moderation)
 *  - Publisher-supplied trustTier/renderMode are ignored on INSERT
 *  - Existing trustTier/renderMode are preserved on UPDATE (separate
 *    pre-write check 403s on attempted change)
 */

const { mockValidator, mockEnv } = vi.hoisted(() => {
  // The handler now calls the async submission gate (validate + settings-pattern
  // ReDoS check). Point validateSubmission at the SAME fn as validate so existing
  // `mockValidator.validate.mockReturnValue(...)` overrides drive both.
  const validate = vi.fn(() => ({ valid: true }));
  const validator = { validate, validateSubmission: validate };
  return {
    mockValidator: validator,
    mockEnv: {
      JOB_TOKEN: 'job-secret',
      BLOCK_TOKEN_PRIVATE_KEY: 'x',
      BLOCK_TOKEN_PUBLIC_KEY: 'x',
    } as Record<string, unknown>,
  };
});

vi.mock('~/env/server', () => ({ env: mockEnv }));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));
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
  mockEnv.JOB_TOKEN = 'job-secret';
  mockValidator.validate.mockReturnValue({ valid: true });
  mockDbRead.oauthClient.findUnique.mockResolvedValue({
    allowedScopes: 0xffffffn,
    allowedOrigins: ['https://blocks.civitai.com'],
  });
  mockDbWrite.appBlock.findUnique.mockResolvedValue(null);
  mockDbWrite.appBlock.create.mockResolvedValue({ id: 'ab_new', status: 'pending' });
  mockDbWrite.appBlock.updateMany.mockResolvedValue({ count: 1 });
});

const createData = () =>
  (mockDbWrite.appBlock.create.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> }).data;
const updateArgs = () =>
  mockDbWrite.appBlock.updateMany.mock.calls.at(-1)?.[0] as {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  };
const expectNoWrite = () => {
  expect(mockDbWrite.appBlock.create).not.toHaveBeenCalled();
  expect(mockDbWrite.appBlock.updateMany).not.toHaveBeenCalled();
};

describe('POST /api/v1/developer/block-manifests', () => {
  describe('consecutive hyphens in a NEW blockId', () => {
    const bodyFor = (blockId: string) => ({
      ...VALID_BODY,
      manifest: { ...VALID_BODY.manifest, blockId },
    });

    it.each(['my--app', 'a---b'])('422s a new block %s without writing', async (blockId) => {
      const { default: handler } = await import('~/pages/api/v1/developer/block-manifests');
      const res = makeRes();
      await handler(makeReq({ body: bodyFor(blockId) }), res);
      expect(res._status).toBe(422);
      expect(res._body).toEqual({
        error: 'Invalid manifest',
        details: [
          `blockId "${blockId}" must not contain consecutive hyphens ("--"): app storage treats a run of hyphens as a single separator, so it could share storage with another app. Use single hyphens.`,
        ],
      });
      expectNoWrite();
    });

    it('422s a new block with a reserved blockId without writing', async () => {
      const { default: handler } = await import('~/pages/api/v1/developer/block-manifests');
      const res = makeRes();
      await handler(makeReq({ body: bodyFor('dev-0123456789abcdef') }), res);
      expect(res._status).toBe(422);
      expect(res._body).toEqual({
        error: 'Invalid manifest',
        details: [
          `blockId "dev-0123456789abcdef" is reserved: ids starting with "dev-" are used for dev tunnel hosts, so the app's address would never reach it. Choose a different blockId.`,
        ],
      });
      expectNoWrite();
    });

    it.each(['my-app', 'ab-c-d', 'plainapp'])('accepts a new block %s', async (blockId) => {
      const { default: handler } = await import('~/pages/api/v1/developer/block-manifests');
      const res = makeRes();
      await handler(makeReq({ body: bodyFor(blockId) }), res);
      expect(res._status).toBe(200);
      expect(mockDbWrite.appBlock.create).toHaveBeenCalledTimes(1);
    });

    it('accepts an update to an EXISTING block whose blockId contains consecutive hyphens', async () => {
      mockDbWrite.appBlock.findUnique.mockResolvedValue({
        id: 'ab_legacy',
        manifest: { something: 'old' },
        status: 'approved',
        trustTier: 'unverified',
        renderMode: 'iframe',
      });
      const { default: handler } = await import('~/pages/api/v1/developer/block-manifests');
      const res = makeRes();
      await handler(makeReq({ body: bodyFor('old--name') }), res);
      expect(res._status).toBe(200);
      expect(mockDbWrite.appBlock.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  it('H-1: update branch sets status=pending (re-enters moderation)', async () => {
    mockDbWrite.appBlock.findUnique.mockResolvedValue({
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
    expect(updateArgs().data.status).toBe('pending');
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
    expect(createData().trustTier).toBe('unverified');
    expect(createData().renderMode).toBe('iframe');
  });

  it('SPEND: a manifest-declared spendTier / cap override NEVER reaches the row (INSERT)', async () => {
    // 🔴 A developer must not be able to raise their own abuse ceiling. The
    // spend columns are mod-only (BlockRegistry.setAppSpendCapConfig); this
    // endpoint's create payload is an explicit allowlist, so a hostile manifest
    // key is simply not carried. Driving the REAL handler rather than asserting
    // on the allowlist by inspection.
    const { default: handler } = await import('~/pages/api/v1/developer/block-manifests');
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          ...VALID_BODY,
          manifest: {
            ...VALID_BODY.manifest,
            spendTier: 'platform',
            spendCapBuzzPerDay: 1_000_000_000,
            spendVelocityMaxGens: 100_000,
          },
        },
      }),
      res
    );
    expect(res._status).toBe(200);
    for (const key of ['spendTier', 'spendCapBuzzPerDay', 'spendVelocityMaxGens'])
      expect(createData()).not.toHaveProperty(key);
  });

  it('SPEND: a manifest-declared spendTier NEVER reaches the row (UPDATE branch)', async () => {
    mockDbWrite.appBlock.findUnique.mockResolvedValue({
      id: 'ab_existing',
      manifest: { something: 'old' },
      status: 'approved',
      trustTier: 'unverified',
      renderMode: 'iframe',
    });
    const { default: handler } = await import('~/pages/api/v1/developer/block-manifests');
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          ...VALID_BODY,
          manifest: { ...VALID_BODY.manifest, spendTier: 'platform' },
        },
      }),
      res
    );
    expect(res._status).toBe(200);
    expect(updateArgs().data).not.toHaveProperty('spendTier');
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
    expect(createData().renderMode).toBe('iframe');
    expect(createData().trustTier).toBe('unverified');
  });

  describe('stores tagline/repository trimmed', () => {
    const TAGLINE = 'Pitch: ' + 'abcdefghij'.repeat(13) + 'xyz';
    const REPO = 'https://github.com/example-org/test-block';
    const PAD = ` \t\n${' '.repeat(600)}\n\t `;
    const paddedBody = () => ({
      ...VALID_BODY,
      manifest: {
        ...VALID_BODY.manifest,
        tagline: `${PAD}${TAGLINE}${PAD}`,
        repository: `${PAD}${REPO}${PAD}`,
      },
    });
    type Written = { manifest: Record<string, unknown> };

    it('writes the trimmed values on both the create and update payloads', async () => {
      const { default: handler } = await import('~/pages/api/v1/developer/block-manifests');
      await handler(makeReq({ body: paddedBody() }), makeRes());
      mockDbWrite.appBlock.findUnique.mockResolvedValue({
        id: 'ab_existing',
        manifest: { something: 'old' },
        status: 'approved',
        trustTier: 'unverified',
        renderMode: 'iframe',
      });
      const res = makeRes();
      await handler(makeReq({ body: paddedBody() }), res);
      expect(res._status).toBe(200);
      expect(TAGLINE).toHaveLength(140);
      const created = createData() as Written;
      const updated = updateArgs().data as Written;
      expect(created.manifest.tagline).toBe(TAGLINE);
      expect(created.manifest.repository).toBe(REPO);
      expect(updated.manifest.tagline).toBe(TAGLINE);
      expect(updated.manifest.repository).toBe(REPO);
    });

    it('a padded re-upload of the stored (trimmed) manifest is unchanged, not re-moderated', async () => {
      mockDbWrite.appBlock.findUnique.mockResolvedValue({
        id: 'ab_existing',
        manifest: { ...VALID_BODY.manifest, tagline: TAGLINE, repository: REPO },
        status: 'approved',
        trustTier: 'unverified',
        renderMode: 'iframe',
      });
      const { default: handler } = await import('~/pages/api/v1/developer/block-manifests');
      const res = makeRes();
      await handler(makeReq({ body: paddedBody() }), res);
      expect(res._status).toBe(200);
      expect(res._body).toEqual({ id: 'ab_existing', status: 'approved', unchanged: true });
      expectNoWrite();
    });
  });

  describe('a remix app row', () => {
    const row = (status: string, manifest: unknown = VALID_BODY.manifest) => ({
      id: 'ab_rx_remix',
      manifest,
      status,
      trustTier: 'unverified',
      renderMode: 'iframe',
    });
    const REFUSAL = { error: 'A remix app is edited on the remix apps page.' };

    it.each(['remix', 'remix_disabled'])(
      '🔴 409s an upload onto a remix row (status %s) without writing, even when the manifest is unchanged',
      async (status) => {
        mockDbWrite.appBlock.findUnique.mockResolvedValue(row(status));
        const { default: handler } = await import('~/pages/api/v1/developer/block-manifests');
        const res = makeRes();
        await handler(makeReq({ body: VALID_BODY }), res);
        expect(res._status).toBe(409);
        expect(res._body).toEqual(REFUSAL);
        expectNoWrite();
      }
    );

    it('🔴 the update is conditional on a non-remix status, and 409s when the row became one under it', async () => {
      mockDbWrite.appBlock.findUnique
        .mockResolvedValueOnce(row('approved', { something: 'old' }))
        .mockResolvedValueOnce({ status: 'remix' });
      mockDbWrite.appBlock.updateMany.mockResolvedValue({ count: 0 });
      const { default: handler } = await import('~/pages/api/v1/developer/block-manifests');
      const res = makeRes();
      await handler(makeReq({ body: VALID_BODY }), res);
      expect(updateArgs().where).toEqual({
        id: 'ab_rx_remix',
        status: { notIn: ['remix', 'remix_disabled'] },
      });
      expect(res._status).toBe(409);
      expect(res._body).toEqual(REFUSAL);
    });

    it('a row gone under the update is a retryable conflict, not a remix refusal', async () => {
      mockDbWrite.appBlock.findUnique
        .mockResolvedValueOnce(row('approved', { something: 'old' }))
        .mockResolvedValueOnce(null);
      mockDbWrite.appBlock.updateMany.mockResolvedValue({ count: 0 });
      const { default: handler } = await import('~/pages/api/v1/developer/block-manifests');
      const res = makeRes();
      await handler(makeReq({ body: VALID_BODY }), res);
      expect(res._status).toBe(409);
      expect(res._body).toEqual({
        error: 'This block changed while it was being written. Try again.',
      });
    });

    it('reads the row from the primary, never a replica', async () => {
      mockDbRead.appBlock.findUnique.mockResolvedValue(row('approved', { something: 'old' }));
      const { default: handler } = await import('~/pages/api/v1/developer/block-manifests');
      await handler(makeReq({ body: VALID_BODY }), makeRes());
      expect(mockDbRead.appBlock.findUnique).not.toHaveBeenCalled();
      expect(mockDbWrite.appBlock.findUnique).toHaveBeenCalled();
    });

    it('CONTROL: an approved store row with a changed manifest still goes back to pending', async () => {
      mockDbWrite.appBlock.findUnique.mockResolvedValue(row('approved', { something: 'old' }));
      const { default: handler } = await import('~/pages/api/v1/developer/block-manifests');
      const res = makeRes();
      await handler(makeReq({ body: VALID_BODY }), res);
      expect(res._status).toBe(200);
      expect(res._body).toEqual({ id: 'ab_rx_remix', status: 'pending', requiresReapproval: true });
      expect(updateArgs().data.status).toBe('pending');
    });
  });

  it('409s a create that lost a race to another create, and updates nothing', async () => {
    mockDbWrite.appBlock.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      })
    );
    const { default: handler } = await import('~/pages/api/v1/developer/block-manifests');
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res._status).toBe(409);
    expect(mockDbWrite.appBlock.updateMany).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/developer/block-manifests — JOB_TOKEN not configured', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace-only', '  '],
  ])(
    '503s when JOB_TOKEN is %s, even for a caller presenting the same value',
    async (_label, secret) => {
      mockEnv.JOB_TOKEN = secret;
      const { default: handler } = await import('~/pages/api/v1/developer/block-manifests');
      const res = makeRes();
      await handler(makeReq({ body: VALID_BODY, token: secret }), res);
      expect(res._status).toBe(503);
      expectNoWrite();
    }
  );

  it('POSITIVE CONTROL: a configured JOB_TOKEN still 401s a wrong header', async () => {
    const { default: handler } = await import('~/pages/api/v1/developer/block-manifests');
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY, token: 'wrong' }), res);
    expect(res._status).toBe(401);
  });
});
