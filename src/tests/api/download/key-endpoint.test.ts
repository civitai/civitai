import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// The catch-all `/api/download/[...key]` handler resolves a download key via the
// delivery worker and 302-redirects to the signed URL. We drive its branches in
// isolation by mocking the delivery worker, auth, the ip-blacklist db read, and
// request-ip. `DeliveryWorkerError` is defined INSIDE the mock so the handler's
// `err instanceof DeliveryWorkerError` sees the same class we throw here
// (faithful: in prod getDownloadUrl throws exactly this typed error — see
// src/utils/__tests__/delivery-worker.test.ts for the real error-shape proof).
const { mockGetDownloadUrl, MockDeliveryWorkerError } = vi.hoisted(() => {
  class MockDeliveryWorkerError extends Error {
    readonly statusCode: number;
    constructor(statusCode: number, statusText: string) {
      super(`Delivery worker error: ${statusText}`);
      this.name = 'DeliveryWorkerError';
      this.statusCode = statusCode;
    }
  }
  return { mockGetDownloadUrl: vi.fn(), MockDeliveryWorkerError };
});

vi.mock('~/utils/delivery-worker', () => ({
  getDownloadUrl: mockGetDownloadUrl,
  DeliveryWorkerError: MockDeliveryWorkerError,
}));

const { mockGetServerAuthSession } = vi.hoisted(() => ({ mockGetServerAuthSession: vi.fn() }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: mockGetServerAuthSession,
}));

// The client IP is NOT mocked: the handler derives it via getTrustedClientIp,
// so these tests drive the real derivation by supplying the edge headers /
// transport peer the way a real request would. Mocking the derivation away
// would leave the blacklist test asserting against a value no request can
// actually produce.

// Mock the Axiom logger. `safeError` mirrors the real @civitai/axiom shape
// (spreads `name: <errClass>` which the handler overrides). We assert server-fault
// branches log and client-fault branches do NOT.
const { mockLogToAxiom } = vi.hoisted(() => ({
  mockLogToAxiom: vi.fn(() => Promise.resolve()),
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: mockLogToAxiom,
  safeError: (e: unknown) =>
    e instanceof Error ? { name: e.name, message: e.message } : { message: String(e) },
}));

// isClientAbortError (~/server/utils/errorHandling) is kept REAL so the handler's
// real abort classification runs.

import handler from '~/pages/api/download/[...key]';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockFindUnique = dbMock.dbRead.keyValue.findUnique;
// The withheld-file lookup. No key belongs to a deleted or taken-down model unless a test says so.
const mockQueryRaw = dbMock.dbRead.$queryRaw;
beforeEach(() => {
  mockQueryRaw.mockResolvedValue([] as never);
});

// Default to a key under the authed user's own `<type>/<userId>/` prefix so the branch tests below
// pass the ownership gate (added below) and still reach the delivery worker. The
// gate itself is covered by its own describe block at the end.
function createMocks({
  key = ['model', '42', 'file.safetensors'],
  headers = {},
  remoteAddress,
}: {
  key?: string[];
  headers?: Record<string, string>;
  remoteAddress?: string;
} = {}) {
  const req = {
    method: 'GET',
    headers,
    query: { key },
    socket: remoteAddress ? { remoteAddress } : undefined,
  } as unknown as NextApiRequest;

  let statusCode = 200;
  let payload: any = undefined;
  let redirectedTo: string | undefined;
  let ended = false;
  const resHeaders: Record<string, string> = {};

  const res = {
    headersSent: false,
    setHeader(name: string, value: string) {
      resHeaders[name.toLowerCase()] = value;
      return res;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: any) {
      payload = body;
      return res;
    },
    redirect(url: string) {
      redirectedTo = url;
      return res;
    },
    end() {
      ended = true;
      return res;
    },
    _getStatusCode: () => statusCode,
    _getJSONData: () => payload,
    _getRedirect: () => redirectedTo,
    _getHeader: (name: string) => resHeaders[name.toLowerCase()],
    _ended: () => ended,
  } as unknown as NextApiResponse & {
    _getStatusCode: () => number;
    _getJSONData: () => any;
    _getRedirect: () => string | undefined;
    _getHeader: (name: string) => string | undefined;
    _ended: () => boolean;
  };

  return { req, res };
}

const authedSession = { user: { id: 42 } };

describe('/api/download/[...key] — unresolvable key returns 4xx, not 500', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Defaults: no blacklist, no derivable ip (no edge headers, no socket peer),
    // authed user. Individual tests override.
    mockFindUnique.mockResolvedValue({ value: '' });
    mockGetServerAuthSession.mockResolvedValue(authedSession);
  });

  it('happy path: a resolvable key 302-redirects to the signed url (unchanged)', async () => {
    mockGetDownloadUrl.mockResolvedValue({
      url: 'https://cdn.example.com/signed-url',
      urlExpiryDate: new Date(),
    });
    // Own-prefix key for the authed user (id 42) so it passes the ownership gate and the redirect
    // path is what we assert; the gate is covered in its own describe block below.
    const { req, res } = createMocks({ key: ['model', '42', 'file.safetensors'] });

    await handler(req, res);

    expect(mockGetDownloadUrl).toHaveBeenCalledWith('model/42/file.safetensors');
    expect(res._getRedirect()).toBe('https://cdn.example.com/signed-url');
    expect(res._getStatusCode()).toBe(200); // status() never called on the redirect path
    // The route now emits one info-level audit log per request; a client-fault must still never
    // ERROR-log to Axiom (an unresolvable key is expected).
    expect(mockLogToAxiom).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('unresolvable key (delivery worker 404) → clean 404, does NOT throw / 500', async () => {
    // The dominant dp-prod 500: `/api/download/images/127209598` → key
    // "images/127209598" → worker 404. Pre-fix this threw an unguarded 500.
    mockGetDownloadUrl.mockRejectedValue(new MockDeliveryWorkerError(404, 'Not Found'));
    // Own-prefix key so it passes the ownership gate and the worker's own 404 is what we assert.
    const { req, res } = createMocks({ key: ['model', '42', 'missing.safetensors'] });

    await expect(handler(req, res)).resolves.toBe(res); // resolves (no throw)
    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData()).toEqual({ error: 'Not found' });
    expect(res._getRedirect()).toBeUndefined();
    expect(res._getHeader('retry-after')).toBeUndefined();
    // Client-fault: MUST NOT error-log to Axiom (an unresolvable key is expected).
    // The route now emits one info-level audit log per request; a client-fault must still never
    // ERROR-log to Axiom (an unresolvable key is expected).
    expect(mockLogToAxiom).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('delivery worker 410 (gone) → 404', async () => {
    mockGetDownloadUrl.mockRejectedValue(new MockDeliveryWorkerError(410, 'Gone'));
    const { req, res } = createMocks();

    await handler(req, res);

    expect(res._getStatusCode()).toBe(404);
    // The route now emits one info-level audit log per request; a client-fault must still never
    // ERROR-log to Axiom (an unresolvable key is expected).
    expect(mockLogToAxiom).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('delivery worker 400 (malformed key) → 400', async () => {
    mockGetDownloadUrl.mockRejectedValue(new MockDeliveryWorkerError(400, 'Bad Request'));
    const { req, res } = createMocks();

    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({ error: 'Invalid download key' });
    // Client-fault: no Axiom error log.
    // The route now emits one info-level audit log per request; a client-fault must still never
    // ERROR-log to Axiom (an unresolvable key is expected).
    expect(mockLogToAxiom).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it.each([500, 502, 503, 504])(
    'genuine transient backend error (delivery worker %i) → 5xx (503, retryable) — NOT masked as 404',
    async (status) => {
      mockGetDownloadUrl.mockRejectedValue(new MockDeliveryWorkerError(status, 'backend down'));
      const { req, res } = createMocks();

      await expect(handler(req, res)).resolves.toBe(res);
      expect(res._getStatusCode()).toBe(503);
      expect(res._getStatusCode()).not.toBe(404);
      expect(res._getJSONData()).toEqual({ error: 'Download temporarily unavailable' });
      expect(res._getHeader('retry-after')).toBe('2');
      // Server-fault: error-logged to Axiom with the stable name + classified status. (One info
      // audit log also fires per request now, so assert the error log by shape, not call count.)
      expect(mockLogToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          name: 'resolve-download-url-failed',
          status: 503,
          workerStatus: status,
        })
      );
    }
  );

  it('worker 403 / 429 (ambiguous, not a clean not-found) → kept 5xx, never 404', async () => {
    for (const status of [403, 429]) {
      mockGetDownloadUrl.mockRejectedValue(new MockDeliveryWorkerError(status, 'nope'));
      const { req, res } = createMocks();
      await handler(req, res);
      expect(res._getStatusCode()).toBe(503);
      expect(res._getStatusCode()).not.toBe(404);
      // Server-fault: error-logged to Axiom.
      expect(mockLogToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'resolve-download-url-failed', status: 503 })
      );
    }
  });

  it('network/transport reject (plain Error, not a DeliveryWorkerError) → hard 500 (unknown cause)', async () => {
    // A fetch transport reject (S3/worker unreachable) surfaces as a non-typed
    // error. We keep it a hard 500 — not a 404 (don't claim not-found) and not a
    // 503 (don't claim retryable for an unknown failure).
    mockGetDownloadUrl.mockRejectedValue(new TypeError('fetch failed'));
    const { req, res } = createMocks();

    await expect(handler(req, res)).resolves.toBe(res);
    expect(res._getStatusCode()).toBe(500);
    expect(res._getJSONData()).toEqual({ error: 'Error resolving download' });
    expect(res._getStatusCode()).not.toBe(404);
    // Server-fault: error-logged to Axiom with the transport error's details.
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'resolve-download-url-failed',
        status: 500,
        message: 'fetch failed',
      })
    );
  });

  it('delivery worker returns OK but no url → 5xx (502), never redirects to undefined', async () => {
    mockGetDownloadUrl.mockResolvedValue({ url: undefined, urlExpiryDate: new Date() });
    const { req, res } = createMocks();

    await handler(req, res);

    expect(res._getStatusCode()).toBe(502);
    expect(res._getRedirect()).toBeUndefined();
    // Server-fault (backend contract violation): error-logged to Axiom.
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'resolve-download-url-failed', status: 502 })
    );
  });

  it('blacklisted ip → 403 (unchanged), never calls the delivery worker', async () => {
    mockFindUnique.mockResolvedValue({ value: '9.9.9.9,1.2.3.4' });
    const { req, res } = createMocks({
      headers: { 'cf-ray': '8a1b2c3d4e5f6789-IAD', 'cf-connecting-ip': '1.2.3.4' },
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData()).toEqual({ error: 'Forbidden' });
    expect(mockGetDownloadUrl).not.toHaveBeenCalled();
  });

  it('blacklisted transport peer → 403, never calls the delivery worker', async () => {
    mockFindUnique.mockResolvedValue({ value: '9.9.9.9,1.2.3.4' });
    const { req, res } = createMocks({ remoteAddress: '1.2.3.4' });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(mockGetDownloadUrl).not.toHaveBeenCalled();
  });

  it('missing key → 400 (unchanged)', async () => {
    const { req, res } = createMocks({ key: [] });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({ error: 'Missing key' });
    expect(mockGetDownloadUrl).not.toHaveBeenCalled();
  });

  it('unauthenticated + JSON content-type → 401 (unchanged)', async () => {
    mockGetServerAuthSession.mockResolvedValue(null);
    const { req, res } = createMocks({ headers: { 'content-type': 'application/json' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(401);
    expect(res._getJSONData()).toEqual({ error: 'Unauthorized' });
    expect(mockGetDownloadUrl).not.toHaveBeenCalled();
  });

  it('unauthenticated + browser (non-JSON) → redirect to /login (unchanged)', async () => {
    mockGetServerAuthSession.mockResolvedValue(null);
    const { req, res } = createMocks({ key: ['modelVersion', '5', 'a.bin'] });

    await handler(req, res);

    expect(res._getRedirect()).toBe('/login?returnUrl=/api/download/modelVersion/5/a.bin');
    expect(mockGetDownloadUrl).not.toHaveBeenCalled();
  });
});

/**
 * Ownership scope: a signed-in caller may resolve only keys under their own `<type>/<userId>/`
 * prefix (buildUploadKey), plus moderators. Any other key is 404, so the response does not confirm
 * whether the object exists and the delivery worker is never asked to resolve it.
 */
describe('/api/download/[...key] — ownership scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUnique.mockResolvedValue({ value: '' });
    mockGetDownloadUrl.mockResolvedValue({
      url: 'https://cdn.example.com/signed',
      urlExpiryDate: new Date(),
    });
  });

  it("resolves the caller's own-prefix key", async () => {
    mockGetServerAuthSession.mockResolvedValue({ user: { id: 42, isModerator: false } });
    const { req, res } = createMocks({ key: ['model', '42', 'mine.safetensors'] });

    await handler(req, res);

    expect(mockGetDownloadUrl).toHaveBeenCalledWith('model/42/mine.safetensors');
    expect(res._getRedirect()).toBe('https://cdn.example.com/signed');
  });

  it.each([
    ["another user's upload key", ['model', '99', 'other-user.safetensors']],
    ['a version-prefixed key', ['modelVersion', '123', 'other-user.safetensors']],
  ])('refuses %s with 404 and never resolves it', async (_label, key) => {
    mockGetServerAuthSession.mockResolvedValue({ user: { id: 42, isModerator: false } });
    const { req, res } = createMocks({ key });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData()).toEqual({ error: 'Not found' });
    expect(mockGetDownloadUrl).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a .. traversal segment past the owned prefix',
      ['model', '42', '..', '..', 'model', '99', 'f.safetensors'],
    ],
    [
      'an encoded separator inside a segment',
      ['model', '42', '..%2f..%2fmodel%2f99%2ff.safetensors'],
    ],
  ])('refuses %s with 404, even though segment 1 is the caller', async (_label, key) => {
    mockGetServerAuthSession.mockResolvedValue({ user: { id: 42, isModerator: false } });
    const { req, res } = createMocks({ key });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(404);
    expect(mockGetDownloadUrl).not.toHaveBeenCalled();
  });

  it('refuses a .. traversal even for a moderator', async () => {
    mockGetServerAuthSession.mockResolvedValue({ user: { id: 42, isModerator: true } });
    const { req, res } = createMocks({ key: ['model', '42', '..', 'secrets', 'f.bin'] });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(404);
    expect(mockGetDownloadUrl).not.toHaveBeenCalled();
  });

  it('CONTROL: a moderator resolves any key', async () => {
    // Without this arm a mutant that refused everyone but the key-owner would pass the cases above.
    mockGetServerAuthSession.mockResolvedValue({ user: { id: 42, isModerator: true } });
    const { req, res } = createMocks({ key: ['model', '99', 'any.safetensors'] });

    await handler(req, res);

    expect(mockGetDownloadUrl).toHaveBeenCalledWith('model/99/any.safetensors');
  });
});

describe('/api/download/[...key] — a deleted or taken-down model', () => {
  const KEY = ['model', '42', 'mine.safetensors'];
  const BUCKET = 'https://storage.example.com/bucket';
  // The lookup's SQL runs on a real Postgres (PGlite) with its values bound as parameters, so the
  // matching, the state filter and the owner scope are the database's, not a stand-in's.
  let pg: PGlite;
  let nextId = 1;
  const addFile = async (
    userId: number,
    state: 'Published' | 'Deleted' | 'TakenDown',
    url: string
  ) => {
    const id = nextId++;
    await pg.query(`INSERT INTO "Model" (id, "userId", status, mode) VALUES ($1, $2, $3, $4)`, [
      id,
      userId,
      state === 'Deleted' ? 'Deleted' : 'Published',
      state === 'TakenDown' ? 'TakenDown' : null,
    ]);
    await pg.query(`INSERT INTO "ModelVersion" (id, "modelId") VALUES ($1, $1)`, [id]);
    await pg.query(`INSERT INTO "ModelFile" (id, "modelVersionId", url) VALUES ($1, $1, $2)`, [
      id,
      url,
    ]);
  };
  const request = async (key: string[], user = { id: 42, isModerator: false }) => {
    mockGetServerAuthSession.mockResolvedValue({ user });
    const { req, res } = createMocks({ key });
    await handler(req, res);
    return res;
  };

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL, status text NOT NULL, mode text);
      CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
      CREATE TABLE "ModelFile" (id int PRIMARY KEY, "modelVersionId" int NOT NULL, url text NOT NULL);
    `);
  });
  afterAll(() => pg.close());

  beforeEach(async () => {
    vi.clearAllMocks();
    await pg.exec(`TRUNCATE "Model", "ModelVersion", "ModelFile"`);
    mockFindUnique.mockResolvedValue({ value: '' });
    mockGetDownloadUrl.mockResolvedValue({
      url: 'https://cdn.example.com/signed',
      urlExpiryDate: new Date(),
    });
    mockQueryRaw.mockImplementation(((sql: TemplateStringsArray, ...values: unknown[]) =>
      pg
        .query(
          sql.reduce((text, part, i) => `${text}$${i}${part}`),
          values
        )
        .then((r) => r.rows)) as never);
  });

  it.each([
    ['a plain url', `${BUCKET}/model/42/mine.safetensors`],
    ['a url that encodes the path separators', `${BUCKET}/model%2F42%2Fmine.safetensors`],
    ['a url that encodes them in lower case', `${BUCKET}/model%2f42%2fmine.safetensors`],
    ['a url with a query string', `${BUCKET}/model/42/mine.safetensors?X-Amz-Expires=43200`],
  ])("refuses its owner a taken-down model's file stored at %s", async (_, url) => {
    await addFile(42, 'TakenDown', url);

    const res = await request(KEY);

    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData()).toEqual({ error: 'Not found' });
    expect(mockGetDownloadUrl).not.toHaveBeenCalled();
  });

  it.each([
    ['a space', 'my file.safetensors', `${BUCKET}/model/42/my%20file.safetensors`],
    // The S3 presigner, which wrote these urls, also escapes !'()* where encodeURIComponent does not.
    ['a presigner-escaped character', 'mine.safe(1)', `${BUCKET}/model/42/mine.safe%281%29`],
  ])("refuses its owner a deleted model's file whose url encodes %s", async (_, name, url) => {
    await addFile(42, 'Deleted', url);

    const res = await request(['model', '42', name]);

    expect(res._getStatusCode()).toBe(404);
    expect(mockGetDownloadUrl).not.toHaveBeenCalled();
  });

  it('still serves a moderator', async () => {
    await addFile(42, 'TakenDown', `${BUCKET}/model/42/mine.safetensors`);

    const res = await request(KEY, { id: 1, isModerator: true });

    expect(res._getRedirect()).toBe('https://cdn.example.com/signed');
  });

  it("serves the owner a published model's file", async () => {
    await addFile(42, 'Published', `${BUCKET}/model/42/mine.safetensors`);

    const res = await request(KEY);

    expect(res._getRedirect()).toBe('https://cdn.example.com/signed');
  });

  // Storage keys are case-sensitive: a withheld file must not refuse one that differs only in case.
  it('serves the owner a published file whose name differs only in case from a withheld one', async () => {
    await addFile(42, 'TakenDown', `${BUCKET}/model/42/mine.safetensors`);
    await addFile(42, 'Published', `${BUCKET}/model/42/Mine.safetensors`);

    const res = await request(['model', '42', 'Mine.safetensors']);

    expect(res._getRedirect()).toBe('https://cdn.example.com/signed');
  });

  it("serves the caller when the taken-down file at that key is another user's", async () => {
    await addFile(7, 'TakenDown', `${BUCKET}/model/42/mine.safetensors`);

    const res = await request(KEY);

    expect(res._getRedirect()).toBe('https://cdn.example.com/signed');
  });
});
