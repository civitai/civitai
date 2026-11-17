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
const flags = vi.hoisted(() => ({ modRetractedMedia: true, csamReports: false }));
const getFeatureFlagsAsync = vi.hoisted(() => vi.fn());

// The moderator check, and what `noStore` does there, run for real in
// `retracted-media.mod-only.test.ts`; here `noStore` is honoured so each status's no-store check
// fails if the route stops asking for it.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  ModEndpoint:
    (
      handler: (req: NextApiRequest, res: NextApiResponse, user: unknown) => unknown,
      _methods?: string[],
      opts?: { noStore?: boolean }
    ) =>
    (req: NextApiRequest, res: NextApiResponse) => {
      if (opts?.noStore) res.setHeader('cache-control', 'private, no-store');
      return handler(req, res, { id: 42, isModerator: true });
    },
}));
vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlagsAsync,
}));
vi.mock('~/server/services/retracted-media.service', () => ({
  getRetractedMedia,
  NEEDS_CSAM_QUEUE: 'needs-csam-queue',
}));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity }));
vi.mock('~/server/utils/public-api-rate-limit', () => ({ checkFixedWindow }));
vi.mock('~/utils/s3-utils', () => ({
  getImageUploadBackend: async () => ({ s3: {}, bucket: 'media', backend: 'backblaze' }),
  getGetUrlByKey,
}));

const { default: handler } = await import('~/pages/api/mod/retracted-media/[imageId]');
const { RETRACTED_MEDIA_STREAM_MS } = await import('@civitai/shared/retracted-media');

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
  flags.csamReports = false;
  getFeatureFlagsAsync.mockImplementation(async () => flags);
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

  it('tells a moderator an image with no scanner verdict needs CSAM-queue access', async () => {
    getRetractedMedia.mockResolvedValue('needs-csam-queue');
    const res = await call();
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.body)).toContain('Needs CSAM-queue access');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(getGetUrlByKey).not.toHaveBeenCalled();
  });

  it('answers a probe with eligibility alone: no storage, no audit row', async () => {
    const res = await call({ query: { imageId: '7', probe: '1' } });
    expect(res.statusCode).toBe(204);
    expect(getGetUrlByKey).not.toHaveBeenCalled();
    expect(trackModActivity).not.toHaveBeenCalled();
  });

  it('asks for the CSAM-review tier only for a moderator cleared for CSAM reports', async () => {
    await call();
    expect(getRetractedMedia).toHaveBeenLastCalledWith(7, { csamReview: false });
    flags.csamReports = true;
    await call();
    expect(getRetractedMedia).toHaveBeenLastCalledWith(7, { csamReview: true });
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
    expect(getRetractedMedia).toHaveBeenCalledWith(7, { csamReview: false });
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

  // Deliberate, unlike held-media: a range from mid-file is audited too, or a moderator could pull a
  // file's bytes in ranges with no row. Do not "fix" this to skip seeks without the leads' say.
  it('audits a mid-file range too, so no bytes go out unrecorded', async () => {
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
    expect(trackModActivity).toHaveBeenCalledTimes(1);
  });

  it('refuses a range of an object over the cap, and an encoded object', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response('yt', {
          status: 206,
          headers: {
            'content-type': 'image/png',
            'content-length': '2',
            'content-range': `bytes 0-1/${300 * 1024 * 1024}`,
          },
        })
    );
    expect((await call({ headers: { range: 'bytes=0-1' } })).statusCode).toBe(413);
    fetchMock.mockImplementation(async () => stored('bytes', { 'content-encoding': 'gzip' }));
    expect((await call()).statusCode).toBe(413);
    expect(trackModActivity).not.toHaveBeenCalled();
  });

  it('refuses a range whose total size storage does not state', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response('yt', {
          status: 206,
          headers: {
            'content-type': 'image/png',
            'content-length': '2',
            'content-range': 'bytes 0-1/*',
          },
        })
    );
    expect((await call({ headers: { range: 'bytes=0-1' } })).statusCode).toBe(413);
    expect(trackModActivity).not.toHaveBeenCalled();
  });

  it('asks the rate limit to fail closed', async () => {
    await call();
    expect(checkFixedWindow).toHaveBeenCalledWith(expect.any(String), expect.any(Number), 60, {
      failOpen: false,
    });
  });

  it('audits a range that starts at byte 0, as a video first loads', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response('by', {
          status: 206,
          headers: {
            'content-type': 'image/png',
            'content-length': '2',
            'content-range': 'bytes 0-1/5',
          },
        })
    );
    const res = await call({ headers: { range: 'bytes=0-' } });
    expect(res.statusCode).toBe(206);
    expect(trackModActivity).toHaveBeenCalledTimes(1);
  });

  it('fetches the signed URL with the forwarded range', async () => {
    await call({ headers: { range: 'bytes=2-3' } });
    expect(fetchMock.mock.calls[0][0]).toBe(SIGNED);
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('range')).toBe('bytes=2-3');
  });

  it('reads the kill switch for the signed-in moderator', async () => {
    await call();
    expect(getFeatureFlagsAsync).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: 42 }) })
    );
  });

  it('stops streaming at the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let signal: AbortSignal | undefined;
      fetchMock.mockImplementation(async (_url: string, init: { signal: AbortSignal }) => {
        signal = init.signal;
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('b'));
            init.signal.addEventListener('abort', () => controller.error(new Error('aborted')));
          },
        });
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': '5' },
        });
      });
      let settled = false;
      const pending = call().then((res) => {
        settled = true;
        return res;
      });
      await vi.advanceTimersByTimeAsync(RETRACTED_MEDIA_STREAM_MS - 1);
      expect({ aborted: signal?.aborted, settled }).toEqual({ aborted: false, settled: false });
      await vi.advanceTimersByTimeAsync(1);
      expect(signal?.aborted).toBe(true);
      expect((await pending).statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('/api/mod/retracted-media other failures', () => {
  it('refuses a row whose url is not a storage key, before presigning', async () => {
    getRetractedMedia.mockResolvedValue({
      url: 'https://x.test/y.png',
      type: 'image',
      mimeType: null,
    });
    const res = await call();
    expect(res.statusCode).toBe(422);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(getGetUrlByKey).not.toHaveBeenCalled();
  });

  it('refuses a video type a browser cannot play', async () => {
    getRetractedMedia.mockResolvedValue({ url: KEY, type: 'video', mimeType: 'video/quicktime' });
    fetchMock.mockImplementation(async () => stored('x', { 'content-type': 'video/quicktime' }));
    const res = await call();
    expect(res.statusCode).toBe(415);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it.each([
    [404, 404],
    [416, 416],
  ])('answers a store %i as %i with no-store', async (from, to) => {
    fetchMock.mockImplementation(async () => new Response(null, { status: from }));
    const res = await call();
    expect(res.statusCode).toBe(to);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('keeps the storage URL out of an error answer', async () => {
    fetchMock.mockRejectedValue(new Error(SIGNED));
    const res = await call();
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('store.test');
  });
});
