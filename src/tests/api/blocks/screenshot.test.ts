import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * F-E E5 — the public screenshot-serving route
 * (`/api/blocks/screenshot/[appBlockId]/[file]`). This exercises the SHELL: the
 * dark-flag gate, the approved-only gate, index parsing/bounds, the
 * recorded-record lookup, the content-type allowlist, and (on the happy path)
 * the served headers — incl. the E5 Low-1 `X-Content-Type-Options: nosniff`
 * belt. The S3 fetch + `isAppBlocksEnabled` + `dbRead` are mocked; we never hit
 * a real MinIO. Mirrors the ModEndpoint reproduction in submit-version.test.ts.
 */

const { mockIsAppBlocksEnabled, mockFindUnique, mockUser, mockS3Send } = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn<() => Promise<boolean>>(async () => true),
  mockFindUnique: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => null),
  mockUser: { value: { id: 1, isModerator: true } as { id: number; isModerator?: boolean } | undefined },
  // Typed param so `.mock.calls[0][0]` is a real (non-empty) tuple element.
  mockS3Send: vi.fn(async (_cmd: { Key?: string }) => ({
    Body: { transformToByteArray: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
  })),
}));

vi.mock('~/server/services/app-blocks-flag', () => ({ isAppBlocksEnabled: mockIsAppBlocksEnabled }));
vi.mock('~/server/db/client', () => ({ dbRead: { appBlock: { findUnique: mockFindUnique } } }));
// Faithful MixedAuthEndpoint reproduction: GET-only, passes the (maybe-undefined)
// user straight to the handler — the route's own logic does ALL the gating.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  MixedAuthEndpoint:
    (
      handler: (req: NextApiRequest, res: NextApiResponse, user: unknown) => Promise<unknown>,
      allowedMethods: string[] = ['GET']
    ) =>
    async (req: NextApiRequest, res: NextApiResponse) => {
      if (!req.method || !allowedMethods.includes(req.method)) {
        res.status(405).json({ error: 'Method not allowed' });
        return;
      }
      await handler(req, res, mockUser.value);
    },
}));
// The 200 path lazily imports these; mock so the happy path doesn't touch MinIO.
vi.mock('@aws-sdk/client-s3', () => ({ GetObjectCommand: vi.fn((args: unknown) => args) }));
vi.mock('~/utils/bundle-s3', () => ({
  getBundleBucket: () => 'bundles',
  getBundleS3Client: () => ({ send: mockS3Send }),
}));

function makeReq(appBlockId: string, file: string): NextApiRequest {
  return { method: 'GET', headers: {}, query: { appBlockId, file } } as unknown as NextApiRequest;
}
function makeRes() {
  const headers: Record<string, string> = {};
  const res = {
    _status: 0,
    _body: null as unknown,
    _sent: null as unknown,
    headers,
    setHeader: vi.fn(function (this: any, k: string, v: string) {
      headers[k.toLowerCase()] = v;
      return this;
    }),
    status: vi.fn(function (this: any, n: number) {
      this._status = n;
      return this;
    }),
    json: vi.fn(function (this: any, b: unknown) {
      this._body = b;
      return this;
    }),
    send: vi.fn(function (this: any, b: unknown) {
      this._sent = b;
      return this;
    }),
    end: vi.fn(function (this: any) {
      return this;
    }),
  };
  return res as unknown as NextApiResponse & {
    _status: number;
    _body: unknown;
    _sent: unknown;
    headers: Record<string, string>;
  };
}
async function invoke(appBlockId: string, file: string) {
  const handler = (await import('~/pages/api/blocks/screenshot/[appBlockId]/[file]')).default;
  const res = makeRes();
  await handler(makeReq(appBlockId, file), res);
  return res;
}

const PNG = { key: 'screenshots/ab_1/0.png', index: 0, ext: 'png', contentType: 'image/png' };

describe('GET /api/blocks/screenshot/[appBlockId]/[file] (F-E E5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser.value = { id: 1, isModerator: true };
    mockIsAppBlocksEnabled.mockResolvedValue(true);
    mockFindUnique.mockResolvedValue({ status: 'approved', screenshots: [PNG] });
    mockS3Send.mockResolvedValue({
      Body: { transformToByteArray: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
    });
  });

  it('404s (fail-closed) when the app-blocks flag is dark — without even a DB lookup', async () => {
    mockIsAppBlocksEnabled.mockResolvedValue(false);
    const res = await invoke('ab_1', '0.png');
    expect(res._status).toBe(404);
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('404s for a NON-approved app (never serves its screenshots)', async () => {
    mockFindUnique.mockResolvedValue({ status: 'pending', screenshots: [PNG] });
    const res = await invoke('ab_1', '0.png');
    expect(res._status).toBe(404);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('404s for a missing app (no id-enumeration)', async () => {
    mockFindUnique.mockResolvedValue(null);
    expect((await invoke('ab_missing', '0.png'))._status).toBe(404);
  });

  it('404s on a non-numeric / negative / traversal-y index (client cannot pick an arbitrary key)', async () => {
    expect((await invoke('ab_1', 'abc.png'))._status).toBe(404);
    expect((await invoke('ab_1', '-1.png'))._status).toBe(404);
    expect((await invoke('ab_1', '../secret.png'))._status).toBe(404);
    // no recorded record at this index → 404
    expect((await invoke('ab_1', '99.png'))._status).toBe(404);
  });

  it('404s when the recorded record has a non-allowlisted content-type', async () => {
    mockFindUnique.mockResolvedValue({
      status: 'approved',
      screenshots: [{ key: 'k', index: 0, ext: 'png', contentType: 'text/html' }],
    });
    const res = await invoke('ab_1', '0.png');
    expect(res._status).toBe(404);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('serves an approved app screenshot by index with the validated content-type + nosniff (Low-1)', async () => {
    const res = await invoke('ab_1', '0.png');
    expect(res._status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // The S3 key fetched is the STORED key, never anything the client supplied.
    const sentCmd = mockS3Send.mock.calls[0][0] as { Key?: string };
    expect(sentCmd.Key).toBe('screenshots/ab_1/0.png');
  });
});
