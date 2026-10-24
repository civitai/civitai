import { EventEmitter } from 'events';
import { Writable } from 'stream';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * `/api/mod/held-media/[imageId]`: the CSAM report page's media from storage, past the public CDN.
 * Moderator-only through `ModEndpoint`; this pins what it adds on top: the CSAM reports flag, the
 * refusal of an image that is not held, and that the key is the row's, never the request's.
 */

const KEY = '0b9f5a4e-1d2c-4e3f-8a7b-6c5d4e3f2a1b';

const getHeldMedia = vi.hoisted(() => vi.fn());
const getGetUrlByKey = vi.hoisted(() =>
  vi.fn(async (key: string) => ({ url: `https://store.test/signed/${key}`, bucket: 'b', key }))
);
const trackModActivity = vi.hoisted(() => vi.fn(async () => undefined));
const flags = vi.hoisted(() => ({ csamReports: true }));

// ModEndpoint is the moderator check; the handler is what is under test, called as a moderator.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  ModEndpoint:
    (handler: (req: NextApiRequest, res: NextApiResponse, user: unknown) => unknown) =>
    (req: NextApiRequest, res: NextApiResponse) =>
      handler(req, res, { id: 42, isModerator: true }),
}));
vi.mock('~/server/services/feature-flags.service', () => ({ getFeatureFlags: () => flags }));
vi.mock('~/server/services/held-media.service', () => ({ getHeldMedia }));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity }));
vi.mock('~/utils/s3-utils', () => ({
  getImageUploadBackend: async () => ({ s3: {}, bucket: 'media', backend: 'backblaze' }),
  getGetUrlByKey,
}));

import handler from '~/pages/api/mod/held-media/[imageId]';
import gridView from '~/pages/api/mod/held-media/grid-view';

class FakeRes extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = '';
  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  json(value: unknown) {
    this.body = JSON.stringify(value);
    this.end();
    return this;
  }
  writeHead(code: number, headers: Record<string, string>) {
    this.statusCode = code;
    Object.assign(this.headers, headers);
    return this;
  }
  _write(chunk: Buffer, _enc: string, done: () => void) {
    this.body += chunk.toString();
    done();
  }
}

const fetchMock = vi.fn();

async function call(query: Record<string, string> = { imageId: '7' }, range?: string) {
  const req = Object.assign(new EventEmitter(), {
    method: 'GET',
    query,
    headers: range ? { range } : {},
  }) as unknown as NextApiRequest;
  const res = new FakeRes();
  await handler(req, res as unknown as NextApiResponse);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.csamReports = true;
  getHeldMedia.mockResolvedValue({ url: KEY, type: 'image', mimeType: null });
  fetchMock.mockImplementation(
    async () => new Response('bytes', { status: 200, headers: { 'content-type': 'image/png' } })
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('/api/mod/held-media', () => {
  it('refuses a moderator without the CSAM reports flag, before reading the image', async () => {
    flags.csamReports = false;
    expect((await call()).statusCode).toBe(403);
    expect(getHeldMedia).not.toHaveBeenCalled();
  });

  it('refuses an image that is not held with the not-held answer, and never touches storage', async () => {
    getHeldMedia.mockResolvedValue(null);
    const res = await call();
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-held-media']).toBe('not-held');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(getGetUrlByKey).not.toHaveBeenCalled();
  });

  it('refuses a row whose url is not a storage key, as not held', async () => {
    getHeldMedia.mockResolvedValue({
      url: 'https://elsewhere.test/x.png',
      type: 'image',
      mimeType: null,
    });
    const res = await call();
    expect(res.statusCode).toBe(404);
    expect(getGetUrlByKey).not.toHaveBeenCalled();
  });

  it('answers a probe for a held image without serving it', async () => {
    const res = await call({ imageId: '7', probe: '1' });
    expect(res.statusCode).toBe(204);
    expect(getGetUrlByKey).not.toHaveBeenCalled();
    expect(trackModActivity).not.toHaveBeenCalled();
  });

  it('gives no not-held answer for any other failure, so the page never falls back to the CDN', async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 500 }));
    const failed = await call();
    expect(failed.statusCode).toBe(502);
    expect(failed.headers['x-held-media']).toBeUndefined();
    fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));
    const missing = await call();
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['x-held-media']).toBeUndefined();
    getHeldMedia.mockRejectedValueOnce(new Error('db down'));
    await expect(call()).rejects.toThrow('db down');
  });

  it('stops reading from the store when the client goes away', async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (_url: string, init: { signal: AbortSignal }) => {
      signal = init.signal;
      return new Response('bytes', { status: 200, headers: { 'content-type': 'image/png' } });
    });
    const res = await call();
    res.emit('close');
    expect(signal?.aborted).toBe(true);
  });

  it('fetches the key from the row, whatever key the request names', async () => {
    await call({
      imageId: '7',
      key: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      url: 'https://evil.test',
    });
    expect(getHeldMedia).toHaveBeenCalledWith(7);
    expect(getGetUrlByKey).toHaveBeenCalledWith(KEY, { s3: {}, bucket: 'media', expiresIn: 60 });
    expect(fetchMock.mock.calls[0][0]).toBe(`https://store.test/signed/${KEY}`);
  });

  it('streams the body with the private, inline, unsniffable headers', async () => {
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      'content-type': 'image/png',
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    });
    expect(res.body).toBe('bytes');
  });

  it('forwards a Range and answers 206', async () => {
    fetchMock.mockResolvedValue(
      new Response('by', {
        status: 206,
        headers: { 'content-type': 'image/png', 'content-range': 'bytes 0-1/5' },
      })
    );
    const res = await call({ imageId: '7' }, 'bytes=0-1');
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('range')).toBe('bytes=0-1');
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 0-1/5');
  });

  it.each([
    [404, 404],
    [500, 502],
  ])('maps a store %i to %i', async (from, to) => {
    fetchMock.mockResolvedValue(new Response(null, { status: from }));
    expect((await call()).statusCode).toBe(to);
  });

  it('answers an unsatisfiable range empty, without the store error body length', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response('<Error/>', {
          status: 416,
          headers: { 'content-length': '8', 'content-range': 'bytes */5' },
        })
    );
    const res = await call({ imageId: '7' }, 'bytes=9-');
    expect(res.statusCode).toBe(416);
    expect(res.headers['content-length']).toBeUndefined();
    expect(res.headers['content-range']).toBe('bytes */5');
  });

  it('refuses a video type a browser cannot play', async () => {
    getHeldMedia.mockResolvedValue({ url: KEY, type: 'video', mimeType: 'video/quicktime' });
    fetchMock.mockImplementation(
      async () => new Response('x', { status: 200, headers: { 'content-type': 'video/quicktime' } })
    );
    expect((await call()).statusCode).toBe(415);
  });

  it('records one grid row per page with the count and no image ids', async () => {
    const post = async (body: unknown) => {
      const req = Object.assign(new EventEmitter(), {
        method: 'POST',
        query: {},
        headers: {},
        body,
      }) as unknown as NextApiRequest;
      const res = new FakeRes();
      await gridView(req, res as unknown as NextApiResponse);
      return res.statusCode;
    };
    expect(await post({ count: 12, userId: 9, imageIds: [1, 2] })).toBe(204);
    expect(await post({ count: 5_000, userId: 9 })).toBe(204);
    expect(await post({ count: 0, userId: 9 })).toBe(400);
    expect(await post({ count: 12 })).toBe(400);
    flags.csamReports = false;
    expect(await post({ count: 12, userId: 9 })).toBe(403);
    expect(trackModActivity.mock.calls).toEqual([
      [42, { entityType: 'user', entityId: 9, activity: 'heldMedia:grid:12' }],
      [42, { entityType: 'user', entityId: 9, activity: 'heldMedia:grid:5000' }],
    ]);
  });

  it('logs every response that carries bytes, and none for a refusal', async () => {
    await call();
    getHeldMedia.mockResolvedValueOnce(null);
    await call();
    const serves = loggingMock.logToAxiom.mock.calls
      .map(([line]: [Record<string, unknown>]) => line)
      .filter((line: Record<string, unknown>) => line.name === 'held-media-serve');
    expect(serves).toEqual([
      {
        name: 'held-media-serve',
        type: 'info',
        moderatorId: 42,
        imageId: 7,
        status: 200,
        range: null,
        bytes: null,
      },
    ]);
  });

  it('audits every serve from byte 0 and skips only mid-file ranges', async () => {
    await call();
    await call({ imageId: '7' }, 'bytes=0-1');
    await call({ imageId: '7' }, 'bytes=2-');
    const row = [42, { entityType: 'image', entityId: 7, activity: 'heldMedia:view' }];
    expect(trackModActivity.mock.calls).toEqual([row, row]);
  });
});
