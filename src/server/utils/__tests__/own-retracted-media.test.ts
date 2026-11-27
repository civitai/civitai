import { EventEmitter } from 'events';
import { Writable } from 'stream';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * `/api/retracted-media/own/[imageId]` around `getOwnRetractedMedia` (which images it serves is
 * pinned in the retracted-media.service tests). Storage is the only boundary mocked.
 */

void loggingMock;

const KEY = '0b9f5a4e-1d2c-4e3f-8a7b-6c5d4e3f2a1b';
const SIGNED = `https://store.test/signed/${KEY}?X-Amz-Signature=secret`;

const getGetUrlByKey = vi.hoisted(() => vi.fn());
vi.mock('~/utils/s3-utils', () => ({
  getImageUploadBackend: async () => ({ s3: {}, bucket: 'media', backend: 'backblaze' }),
  getGetUrlByKey,
}));

const { serveOwnRetractedMedia } = await import('~/server/utils/own-retracted-media');

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
const readMedia = vi.fn();
let enabled = true;
let allowed = true;

async function call(query: Record<string, string> = { imageId: '9' }) {
  const req = Object.assign(new EventEmitter(), {
    method: 'GET',
    url: '/api/retracted-media/own/9',
    query,
    headers: {},
  }) as unknown as NextApiRequest;
  const res = new FakeRes();
  await serveOwnRetractedMedia(req, res as unknown as NextApiResponse, {
    enabled: async () => enabled,
    rateLimit: async () => ({ allowed, retryAfterSeconds: 3 }),
    readMedia,
  });
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  enabled = true;
  allowed = true;
  readMedia.mockResolvedValue({ url: KEY, type: 'image', mimeType: null });
  getGetUrlByKey.mockResolvedValue({ url: SIGNED, bucket: 'media', key: KEY });
  fetchMock.mockImplementation(
    async () =>
      new Response('bytes', {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '5' },
      })
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('serveOwnRetractedMedia', () => {
  it("streams the owner's own image through the server, never naming the storage url", async () => {
    const res = await call();
    expect(readMedia).toHaveBeenCalledWith(9);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('bytes');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(JSON.stringify(res.headers)).not.toContain('store.test');
  });

  it('answers as a missing image with the flag off, reading nothing', async () => {
    enabled = false;
    const res = await call();
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(readMedia).not.toHaveBeenCalled();
  });

  it('answers as a missing image when the image is not left to this owner', async () => {
    readMedia.mockResolvedValue(null);
    const res = await call();
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(getGetUrlByKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses over the rate limit and on a failed read, touching no storage', async () => {
    allowed = false;
    const limited = await call();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('3');
    expect(readMedia).not.toHaveBeenCalled();
    allowed = true;
    readMedia.mockRejectedValueOnce(new Error('timeout'));
    expect((await call()).statusCode).toBe(503);
    expect(getGetUrlByKey).not.toHaveBeenCalled();
  });

  it('answers a probe with eligibility alone', async () => {
    const res = await call({ imageId: '9', probe: '1' });
    expect(res.statusCode).toBe(204);
    expect(getGetUrlByKey).not.toHaveBeenCalled();
  });

  it('refuses a bad id', async () => {
    expect((await call({ imageId: 'x' })).statusCode).toBe(400);
  });
});
