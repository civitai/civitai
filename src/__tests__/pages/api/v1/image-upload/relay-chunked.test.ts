import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';
import type { NextApiRequest, NextApiResponse } from 'next';
import client from 'prom-client';
import type * as EnvOther from '~/env/other';
import type * as AuthSession from '~/server/auth/get-server-auth-session';
import type * as S3Utils from '~/utils/s3-utils';
import type * as HttpErrors from '~/server/prom/http-errors';
import type * as OriginHelpers from '~/server/utils/origin-helpers';
import type * as ImageUploadAction from '~/server/services/image-upload-action.service';
import { redisMock } from '~/__tests__/mocks/redis.mock';

// The chunked upload relay (`/api/v1/image-upload/relay-chunked`). New-feature tests: the route
// did not exist before this change, so none of these can be shown red on the pre-change tree
// other than by the module being absent. The SESSION store is a real in-memory hash behind the
// canonical sysRedis mock, so ownership is checked against what the route itself wrote rather
// than against a stubbed lookup.

const {
  mockGetServerAuthSession,
  mockStart,
  mockUploadPart,
  mockComplete,
  mockAbort,
  mockIsAllowedOriginRequest,
  mockTrackImageUpload,
} = vi.hoisted(() => ({
  mockGetServerAuthSession: vi.fn(),
  mockStart: vi.fn(),
  mockUploadPart: vi.fn(),
  mockComplete: vi.fn(),
  mockAbort: vi.fn(),
  mockIsAllowedOriginRequest: vi.fn(),
  mockTrackImageUpload: vi.fn(),
}));

vi.mock('~/env/other', async (importOriginal) => ({
  ...(await importOriginal<typeof EnvOther>()),
  isProd: false,
}));

vi.mock('~/server/auth/get-server-auth-session', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthSession>()),
  getServerAuthSession: mockGetServerAuthSession,
}));

vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  startImageMultipartToStore: mockStart,
  uploadImagePartToStore: mockUploadPart,
  completeImageMultipartToStore: mockComplete,
  abortImageMultipartToStore: mockAbort,
}));

vi.mock('~/server/prom/http-errors', async (importOriginal) => ({
  ...(await importOriginal<typeof HttpErrors>()),
  instrumentApiResponse: vi.fn(),
}));

vi.mock('~/server/utils/origin-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof OriginHelpers>()),
  isAllowedOriginRequest: mockIsAllowedOriginRequest,
}));

vi.mock('~/server/services/image-upload-action.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageUploadAction>()),
  trackImageUpload: mockTrackImageUpload,
}));

import handler, {
  CHUNKED_RELAY_MAX_BYTES,
  CHUNKED_RELAY_PIECE_BYTES,
} from '~/pages/api/v1/image-upload/relay-chunked';
import {
  MAX_CONCURRENT_RELAYS,
  __getInFlightForTest,
  __resetInFlightForTest,
  tryAcquireRelaySlot,
} from '~/pages/api/v1/image-upload/relay';
import {
  IMAGE_UPLOAD_RELAY_METRIC,
  __resetImageUploadRelayMetricsForTest,
} from '~/server/prom/image-upload-relay.metrics';
import { IMAGE_UPLOAD_RELAY_PRODUCER_HEADER } from '~/utils/image-upload-relay-producer';

/** Not a multiple of the piece size, so the last piece is short: 8 MiB + 1,234,567. */
const FILE_SIZE = CHUNKED_RELAY_PIECE_BYTES + 1_234_567;
const LAST_PIECE = FILE_SIZE - CHUNKED_RELAY_PIECE_BYTES;
const OWNER = 7;
const OTHER_USER = 8;
const MINTED_KEY = 'server-minted-uuid';
const UPLOAD_ID = 'multipart-upload-1';

/** sysRedis hashes the route wrote, keyed by full redis key. */
let hashes: Map<string, Record<string, string>>;
let currentUser: number;

type ReqOpts = {
  method?: string;
  query: Record<string, string>;
  body?: Buffer[];
  contentLength?: number;
  contentType?: string;
};

function makeReq({
  method = 'POST',
  query,
  body = [],
  contentLength,
  contentType,
}: ReqOpts): NextApiRequest {
  const req = Readable.from(body) as unknown as NextApiRequest;
  req.method = method;
  req.query = query;
  req.headers = {
    [IMAGE_UPLOAD_RELAY_PRODUCER_HEADER]: 'multipart',
    ...(contentType ? { 'content-type': contentType } : {}),
    ...(contentLength !== undefined ? { 'content-length': String(contentLength) } : {}),
  };
  return req;
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    headersSent: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
    end() {
      this.headersSent = true;
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    getHeader(k: string) {
      return this.headers[k];
    },
  };
  return res as unknown as NextApiResponse & typeof res;
}

async function call(opts: ReqOpts) {
  const res = makeRes();
  await handler(makeReq(opts), res);
  return res;
}

async function start(size = FILE_SIZE) {
  const res = await call({
    query: { action: 'start', size: String(size) },
    contentType: 'image/png',
  });
  return { res, session: (res.body as { session?: string })?.session as string };
}

function sendPart(session: string, part: number, bytes: number, contentLength = bytes) {
  return call({
    query: { action: 'part', session, part: String(part) },
    body: [Buffer.alloc(bytes, part)],
    contentLength,
  });
}

/** Outcome -> count, summed over producers, from the real prom registry. */
async function outcomes(): Promise<Record<string, number>> {
  const metric = client.register.getSingleMetric(IMAGE_UPLOAD_RELAY_METRIC) as unknown as
    | { get: () => Promise<{ values: { labels: Record<string, string>; value: number }[] }> }
    | undefined;
  const counts: Record<string, number> = {};
  for (const v of (await metric?.get())?.values ?? [])
    if (v.value) counts[v.labels.outcome] = (counts[v.labels.outcome] ?? 0) + v.value;
  return counts;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetInFlightForTest();
  __resetImageUploadRelayMetricsForTest();
  hashes = new Map();
  currentUser = OWNER;
  mockGetServerAuthSession.mockImplementation(async () => ({
    user: { id: currentUser, bannedAt: null },
  }));
  mockIsAllowedOriginRequest.mockReturnValue(true);
  mockStart.mockResolvedValue({ key: MINTED_KEY, uploadId: UPLOAD_ID });
  mockUploadPart.mockImplementation(
    async ({ partNumber }: { partNumber: number }) => `etag-${partNumber}`
  );
  mockComplete.mockImplementation(async ({ key }: { key: string }) => ({
    key,
    backend: 'backblaze',
  }));
  mockAbort.mockResolvedValue(undefined);

  redisMock.sysRedis.hSetMultiWithExpire.mockImplementation(
    async (key: string, fields: string[]) => {
      const hash = hashes.get(key) ?? {};
      for (let i = 0; i < fields.length; i += 2) hash[fields[i]] = fields[i + 1];
      hashes.set(key, hash);
      return fields.length / 2;
    }
  );
  redisMock.sysRedis.hGetAll.mockImplementation(async (key: string) => ({
    ...(hashes.get(key) ?? {}),
  }));
  redisMock.sysRedis.del.mockImplementation(async (key: string) => (hashes.delete(key) ? 1 : 0));
});

describe('chunked image-upload relay', () => {
  /**
   * The route's own call to the shared `authorizeRelayRequest`. Every other case runs as a
   * signed-in user, so without these the call could be dropped with the file still green.
   * Each asks for `start`, the step that opens a multipart upload, so a missing guard shows as a
   * storage call rather than only as a status.
   */
  describe('request guard', () => {
    it('refuses a caller with no session', async () => {
      mockGetServerAuthSession.mockResolvedValueOnce(null);
      const { res } = await start();
      expect(res.statusCode).toBe(401);
      expect(mockStart).not.toHaveBeenCalled();
      expect(await outcomes()).toEqual({ unauthorized: 1 });
    });

    it('refuses a banned user', async () => {
      mockGetServerAuthSession.mockResolvedValueOnce({
        user: { id: OWNER, bannedAt: new Date('2026-01-01') },
      });
      const { res } = await start();
      expect(res.statusCode).toBe(401);
      expect(mockStart).not.toHaveBeenCalled();
    });

    it('refuses a non-POST method', async () => {
      const res = await call({
        method: 'GET',
        query: { action: 'start', size: String(FILE_SIZE) },
        contentType: 'image/png',
      });
      expect(res.statusCode).toBe(405);
      expect(res.headers.Allow).toBe('POST');
      expect(mockStart).not.toHaveBeenCalled();
    });

    it('refuses an unknown step without touching storage', async () => {
      const res = await call({ query: { action: 'finish', size: String(FILE_SIZE) } });
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'Unknown relay step' });
      expect(mockStart).not.toHaveBeenCalled();
      expect(mockUploadPart).not.toHaveBeenCalled();
      expect(mockComplete).not.toHaveBeenCalled();
      expect(mockAbort).not.toHaveBeenCalled();
    });
  });

  it('stores a file in pieces and completes it with the server-minted key', async () => {
    const { res: started, session } = await start();
    expect(started.statusCode).toBe(200);
    expect(started.body).toEqual({
      session: expect.any(String),
      pieceSize: CHUNKED_RELAY_PIECE_BYTES,
      partCount: 2,
    });
    // The key and uploadId stay server-side until complete.
    expect(JSON.stringify(started.body)).not.toContain(MINTED_KEY);
    expect(JSON.stringify(started.body)).not.toContain(UPLOAD_ID);
    expect(mockStart).toHaveBeenCalledWith({ contentType: 'image/png' });

    expect((await sendPart(session, 1, CHUNKED_RELAY_PIECE_BYTES)).statusCode).toBe(200);
    expect((await sendPart(session, 2, LAST_PIECE)).statusCode).toBe(200);
    expect(mockUploadPart.mock.calls.map(([a]) => [a.partNumber, a.body.length])).toEqual([
      [1, CHUNKED_RELAY_PIECE_BYTES],
      [2, LAST_PIECE],
    ]);

    const done = await call({ query: { action: 'complete', session } });
    expect(done.statusCode).toBe(200);
    // Same wire shape as the single-shot relay.
    expect(done.body).toEqual({ id: MINTED_KEY });
    expect(mockComplete).toHaveBeenCalledExactlyOnceWith({
      key: MINTED_KEY,
      uploadId: UPLOAD_ID,
      parts: [
        { ETag: 'etag-1', PartNumber: 1 },
        { ETag: 'etag-2', PartNumber: 2 },
      ],
      totalBytes: FILE_SIZE,
    });
    expect(mockTrackImageUpload).toHaveBeenCalledWith(expect.anything(), done, MINTED_KEY);
    // A completed session is consumed: it cannot be completed or aborted again.
    expect((await call({ query: { action: 'complete', session } })).statusCode).toBe(404);
    expect(await outcomes()).toEqual({
      chunk_started: 1,
      chunk_stored: 2,
      success: 1,
      session_invalid: 1,
    });
  });

  describe('session ownership', () => {
    it("refuses another user's part, complete and abort, and touches no storage", async () => {
      const { session } = await start();
      currentUser = OTHER_USER;

      expect((await sendPart(session, 1, CHUNKED_RELAY_PIECE_BYTES)).statusCode).toBe(404);
      expect((await call({ query: { action: 'complete', session } })).statusCode).toBe(404);
      expect((await call({ query: { action: 'abort', session } })).statusCode).toBe(404);

      expect(mockUploadPart).not.toHaveBeenCalled();
      expect(mockComplete).not.toHaveBeenCalled();
      expect(mockAbort).not.toHaveBeenCalled();
      // The owner's session is intact after the probe.
      currentUser = OWNER;
      expect((await sendPart(session, 1, CHUNKED_RELAY_PIECE_BYTES)).statusCode).toBe(200);
    });

    it.each([
      ['an unknown session id', '2b0e3a4c-1d5f-4e6a-9b7c-8d9e0f1a2b3c'],
      ['a malformed session id', 'not-a-session'],
      ['no session id', undefined],
    ])('answers 404 for %s', async (_label, session) => {
      const res = await call({
        query: { action: 'complete', ...(session ? { session } : {}) },
      });
      expect(res.statusCode).toBe(404);
      expect(mockComplete).not.toHaveBeenCalled();
    });
  });

  describe('piece validation', () => {
    it('refuses an over-size piece with 413 before storing anything', async () => {
      const { session } = await start();
      const res = await sendPart(session, 2, LAST_PIECE + 1);
      expect(res.statusCode).toBe(413);
      expect(mockUploadPart).not.toHaveBeenCalled();
      expect(await outcomes()).toMatchObject({ too_large: 1 });
    });

    it('detects a truncated piece (body shorter than its declared length) and stores nothing', async () => {
      const { session } = await start();
      // Declares the full piece, delivers less — the shape of Next's silent body truncation.
      const res = await sendPart(
        session,
        1,
        CHUNKED_RELAY_PIECE_BYTES - 4_321,
        CHUNKED_RELAY_PIECE_BYTES
      );
      expect(res.statusCode).toBe(400);
      expect(mockUploadPart).not.toHaveBeenCalled();
      expect(await outcomes()).toMatchObject({ truncated: 1 });
    });

    it('refuses a declared length short of the plan before reading', async () => {
      const { session } = await start();
      const short = await sendPart(session, 1, CHUNKED_RELAY_PIECE_BYTES - 1);
      expect(short.statusCode).toBe(400);
      expect(mockUploadPart).not.toHaveBeenCalled();
      expect(await outcomes()).toMatchObject({ bad_request: 1 });
    });

    describe('with no Content-Length (a hop that forwards the body chunked)', () => {
      function sendUndeclared(session: string, part: number, bytes: number) {
        return call({
          query: { action: 'part', session, part: String(part) },
          body: [Buffer.alloc(bytes, part)],
        });
      }

      it('accepts a piece of exactly its planned size', async () => {
        const { session } = await start();
        const res = await sendUndeclared(session, 2, LAST_PIECE);
        expect(res.statusCode).toBe(200);
        expect(mockUploadPart.mock.calls.map(([a]) => [a.partNumber, a.body.length])).toEqual([
          [2, LAST_PIECE],
        ]);
      });

      it('refuses a piece longer than planned with 413 and stores nothing', async () => {
        const { session } = await start();
        const res = await sendUndeclared(session, 2, LAST_PIECE + 1);
        expect(res.statusCode).toBe(413);
        expect(mockUploadPart).not.toHaveBeenCalled();
        expect(await outcomes()).toMatchObject({ too_large: 1 });
      });

      it('refuses a piece shorter than planned with 400 and stores nothing', async () => {
        const { session } = await start();
        // Short by an amount unrelated to the piece size, the shape of a silently cut body.
        const res = await sendUndeclared(session, 1, CHUNKED_RELAY_PIECE_BYTES - 98_765);
        expect(res.statusCode).toBe(400);
        expect(mockUploadPart).not.toHaveBeenCalled();
        expect(await outcomes()).toMatchObject({ truncated: 1 });
      });
    });

    it.each(['0', '3', '1.5', 'x'])('refuses part number %s outside the plan', async (part) => {
      const { session } = await start();
      const res = await call({
        query: { action: 'part', session, part },
        body: [Buffer.alloc(LAST_PIECE)],
        contentLength: LAST_PIECE,
      });
      expect(res.statusCode).toBe(400);
      expect(mockUploadPart).not.toHaveBeenCalled();
    });

    it('refuses to complete while a part is missing', async () => {
      const { session } = await start();
      await sendPart(session, 2, LAST_PIECE);
      const res = await call({ query: { action: 'complete', session } });
      expect(res.statusCode).toBe(400);
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it('shares the single-shot relay’s per-pod buffering slots', async () => {
      const { session } = await start();
      const held = makeRes();
      for (let i = 0; i < MAX_CONCURRENT_RELAYS; i++) expect(tryAcquireRelaySlot(held)).toBe(true);

      const res = await sendPart(session, 1, CHUNKED_RELAY_PIECE_BYTES);
      expect(res.statusCode).toBe(429);
      expect(mockUploadPart).not.toHaveBeenCalled();
      // The shed request did not leak a slot of its own.
      expect(__getInFlightForTest()).toBe(MAX_CONCURRENT_RELAYS);
    });

    it('releases its slot after storing a piece', async () => {
      const { session } = await start();
      await sendPart(session, 1, CHUNKED_RELAY_PIECE_BYTES);
      expect(__getInFlightForTest()).toBe(0);
    });

    it('releases its slot when the store write fails', async () => {
      const { session } = await start();
      mockUploadPart.mockRejectedValueOnce(new Error('store down'));
      const res = await sendPart(session, 1, CHUNKED_RELAY_PIECE_BYTES);
      expect(res.statusCode).toBe(500);
      expect(__getInFlightForTest()).toBe(0);
    });
  });

  describe('start', () => {
    it.each([
      ['over the image size cap', CHUNKED_RELAY_MAX_BYTES + 1, 413],
      ['zero', 0, 400],
      ['not an integer', 12.5, 400],
    ])('refuses a size %s without opening a multipart upload', async (_label, size, status) => {
      const { res } = await start(size);
      expect(res.statusCode).toBe(status);
      expect(mockStart).not.toHaveBeenCalled();
    });

    it('accepts exactly the image size cap, planned within the part limit', async () => {
      const { res } = await start(CHUNKED_RELAY_MAX_BYTES);
      expect(res.statusCode).toBe(200);
      expect((res.body as { partCount: number }).partCount).toBe(
        Math.ceil(CHUNKED_RELAY_MAX_BYTES / CHUNKED_RELAY_PIECE_BYTES)
      );
    });

    it('aborts the multipart upload when the session cannot be recorded', async () => {
      redisMock.sysRedis.hSetMultiWithExpire.mockRejectedValueOnce(new Error('redis down'));
      const { res } = await start();
      expect(res.statusCode).toBe(500);
      expect(mockAbort).toHaveBeenCalledExactlyOnceWith({ key: MINTED_KEY, uploadId: UPLOAD_ID });
    });
  });

  it('abort closes the multipart upload and consumes the session', async () => {
    const { session } = await start();
    await sendPart(session, 1, CHUNKED_RELAY_PIECE_BYTES);
    const res = await call({ query: { action: 'abort', session } });
    expect(res.statusCode).toBe(200);
    expect(mockAbort).toHaveBeenCalledExactlyOnceWith({ key: MINTED_KEY, uploadId: UPLOAD_ID });
    expect((await sendPart(session, 2, LAST_PIECE)).statusCode).toBe(404);
  });

  /**
   * An upload already completed or aborted at the store surfaces as `NoSuchUpload`. These go
   * through the REAL `classifyS3MultipartError` (the s3-utils mock spreads the original), the
   * same classifier `/api/upload/{complete,abort}` use; the unclassified error beside each is the
   * control that it is the classification, not any throw, that changes the answer.
   */
  describe('a multipart upload already gone at the store', () => {
    const noSuchUpload = () => Object.assign(new Error('gone'), { name: 'NoSuchUpload' });

    async function startWithAllParts() {
      const { session } = await start();
      await sendPart(session, 1, CHUNKED_RELAY_PIECE_BYTES);
      await sendPart(session, 2, LAST_PIECE);
      return session;
    }

    it('complete answers a terminal 409 and drops the session', async () => {
      const session = await startWithAllParts();
      mockComplete.mockRejectedValueOnce(noSuchUpload());

      const res = await call({ query: { action: 'complete', session } });

      expect(res.statusCode).toBe(409);
      expect(await outcomes()).toMatchObject({ upload_gone: 1 });
      expect(mockTrackImageUpload).not.toHaveBeenCalled();
      expect((await call({ query: { action: 'complete', session } })).statusCode).toBe(404);
    });

    it('complete still answers 500 for an unclassified store error', async () => {
      const session = await startWithAllParts();
      mockComplete.mockRejectedValueOnce(new Error('boom'));

      const res = await call({ query: { action: 'complete', session } });

      expect(res.statusCode).toBe(500);
      expect(await outcomes()).toMatchObject({ store_error: 1 });
    });

    it('abort treats it as already done', async () => {
      const { session } = await start();
      mockAbort.mockRejectedValueOnce(noSuchUpload());

      const res = await call({ query: { action: 'abort', session } });

      expect(res.statusCode).toBe(200);
      expect(await outcomes()).toMatchObject({ chunk_aborted: 1 });
      expect((await call({ query: { action: 'abort', session } })).statusCode).toBe(404);
    });

    it('abort still answers 500 for an unclassified store error', async () => {
      const { session } = await start();
      mockAbort.mockRejectedValueOnce(new Error('boom'));

      const res = await call({ query: { action: 'abort', session } });

      expect(res.statusCode).toBe(500);
      expect(await outcomes()).toMatchObject({ store_error: 1 });
    });
  });
});
