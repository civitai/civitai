import { EventEmitter } from 'events';
import { Writable } from 'stream';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * `/api/mod/retracted-media/[imageId]`: a blocked image for a moderator, from storage rather than the
 * public CDN. The handler, called as a moderator, behind the route's own no-store wrapper.
 */

void loggingMock;

const KEY = '0b9f5a4e-1d2c-4e3f-8a7b-6c5d4e3f2a1b';
const SIGNED = `https://store.test/signed/${KEY}?X-Amz-Signature=secret`;

const getRetractedMedia = vi.hoisted(() => vi.fn());
const getGetUrlByKey = vi.hoisted(() => vi.fn());
const trackModActivity = vi.hoisted(() => vi.fn());
const checkFixedWindow = vi.hoisted(() => vi.fn());
const flags = vi.hoisted(() => ({ modRetractedMedia: true }));

// The moderator check itself runs for real in `retracted-media.mod-only.test.ts`.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  ModEndpoint:
    (handler: (req: NextApiRequest, res: NextApiResponse, user: unknown) => unknown) =>
    (req: NextApiRequest, res: NextApiResponse) =>
      handler(req, res, { id: 42, isModerator: true }),
}));
vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlagsAsync: async () => flags,
}));
vi.mock('~/server/services/retracted-media.service', () => ({ getRetractedMedia }));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity }));
vi.mock('~/server/utils/public-api-rate-limit', () => ({ checkFixedWindow }));
vi.mock('~/utils/s3-utils', () => ({
  getImageUploadBackend: async () => ({ s3: {}, bucket: 'media', backend: 'backblaze' }),
  getGetUrlByKey,
}));

const { default: handler } = await import('~/pages/api/mod/retracted-media/[imageId]');

// Arrow properties: the metrics wrapper around `ModEndpoint` calls these unbound.
class FakeRes extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = '';
  setHeader = (name: string, value: string) => {
    this.headers[name.toLowerCase()] = value;
    return this;
  };
  getHeader = (name: string) => this.headers[name.toLowerCase()];
  status = (code: number) => {
    this.statusCode = code;
    return this;
  };
  json = (value: unknown) => {
    this.body = JSON.stringify(value);
    this.end();
    return this;
  };
  writeHead = (code: number, headers: Record<string, string>) => {
    this.statusCode = code;
    for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = v;
    return this;
  };
  _write(chunk: Buffer, _enc: string, done: () => void) {
    this.body += chunk.toString();
    done();
  }
}

const fetchMock = vi.fn();

async function call(
  opts: { query?: Record<string, string>; headers?: Record<string, string> } = {}
) {
  const req = Object.assign(new EventEmitter(), {
    method: 'GET',
    url: '/api/mod/retracted-media/7',
    query: opts.query ?? { imageId: '7' },
    headers: opts.headers ?? {},
  }) as unknown as NextApiRequest;
  const res = new FakeRes();
  await handler(req, res as unknown as NextApiResponse);
  return res;
}

const stored = (body = 'bytes', headers: Record<string, string> = {}) =>
  new Response(body, {
    status: 200,
    headers: { 'content-type': 'image/png', 'content-length': String(body.length), ...headers },
  });

beforeEach(() => {
  vi.clearAllMocks();
  flags.modRetractedMedia = true;
  getRetractedMedia.mockResolvedValue({ url: KEY, type: 'image', mimeType: null });
  getGetUrlByKey.mockResolvedValue({ url: SIGNED, bucket: 'media', key: KEY });
  trackModActivity.mockResolvedValue(undefined);
  checkFixedWindow.mockResolvedValue({ allowed: true });
  fetchMock.mockImplementation(async () => stored());
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('/api/mod/retracted-media refusals', () => {
  it('refuses every moderator when the kill switch is off', async () => {
    flags.modRetractedMedia = false;
    const res = await call();
    expect(res.statusCode).toBe(403);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(getRetractedMedia).not.toHaveBeenCalled();
  });

  it('refuses a moderator over the rate limit', async () => {
    checkFixedWindow.mockResolvedValue({ allowed: false, retryAfterSeconds: 12 });
    const res = await call();
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('12');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(getRetractedMedia).not.toHaveBeenCalled();
  });

  it('refuses an image the eligibility check does not allow, and never touches storage', async () => {
    getRetractedMedia.mockResolvedValue(null);
    const res = await call();
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(getGetUrlByKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a bad id with no-store', async () => {
    const res = await call({ query: { imageId: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('sends nothing when the audit row cannot be written', async () => {
    trackModActivity.mockRejectedValue(new Error('db down'));
    const res = await call();
    expect(res.statusCode).toBe(503);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body).not.toContain('bytes');
  });

  it('refuses an object over the size cap, and one with no declared length', async () => {
    fetchMock.mockImplementation(async () =>
      stored('bytes', { 'content-length': String(300 * 1024 * 1024) })
    );
    const big = await call();
    expect(big.statusCode).toBe(413);
    expect(big.headers['cache-control']).toBe('private, no-store');
    fetchMock.mockImplementation(
      async () => new Response('bytes', { status: 200, headers: { 'content-type': 'image/png' } })
    );
    expect((await call()).statusCode).toBe(413);
  });

  it('maps a store failure to 502 with no-store', async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 500 }));
    const res = await call();
    expect(res.statusCode).toBe(502);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });
});

describe('/api/mod/retracted-media serving', () => {
  it('streams the original with no-store, audited, and keyed by the row', async () => {
    const res = await call({
      query: { imageId: '7', key: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('bytes');
    expect(res.headers).toMatchObject({
      'content-type': 'image/png',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
    expect(getRetractedMedia).toHaveBeenCalledWith(7);
    expect(getGetUrlByKey).toHaveBeenCalledWith(KEY, { s3: {}, bucket: 'media', expiresIn: 60 });
    expect(trackModActivity).toHaveBeenCalledWith(42, {
      entityType: 'image',
      entityId: 7,
      activity: 'retractedMedia:view',
    });
  });

  it('never hands the browser the storage URL', async () => {
    const res = await call();
    expect(res.headers.location).toBeUndefined();
    expect(JSON.stringify(res.headers)).not.toContain('store.test');
    expect(res.body).not.toContain('store.test');
  });

  it('does not audit a mid-file range again', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response('yt', {
          status: 206,
          headers: {
            'content-type': 'image/png',
            'content-length': '2',
            'content-range': 'bytes 2-3/5',
          },
        })
    );
    const res = await call({ headers: { range: 'bytes=2-3' } });
    expect(res.statusCode).toBe(206);
    expect(trackModActivity).not.toHaveBeenCalled();
  });
});
