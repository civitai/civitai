import { describe, expect, it, vi } from 'vitest';
import type { BlobHead } from './upload-readiness';

// Empty: the client's dist imports a directory, which Node's ESM loader refuses; the probe needs none of it.
vi.mock('@civitai/orchestration-client', () => ({}));

const { classifyBlobHead, probeBlobReadiness } = await import('./upload-readiness');

const answer = (status: number, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers });
const timeout = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });

describe('classifyBlobHead', () => {
  it.each([
    ['a clean file', 204, {}, 'ready'],
    ['a blocked file', 204, { 'x-blocked-reason': 'x' }, 'unusable'],
    ['a missing file', 404, {}, 'unusable'],
    [
      'a file still processing',
      503,
      { 'retry-after': '5', 'x-scan-status': 'Pending' },
      'processing',
    ],
    ['a file whose processing failed', 503, { 'x-scan-status': 'Failed' }, 'failed'],
    ['a 503 from anything else', 503, { 'retry-after': '5' }, null],
    ['an answer about something else', 401, {}, null],
  ] as const)('reads %s', (_, status, headers, want) => {
    expect(classifyBlobHead(status, new Headers(headers))).toBe(want);
  });
});

describe('probeBlobReadiness', () => {
  it('reads each blob once, with a timeout signal', async () => {
    const head = vi.fn<BlobHead>(async () => answer(204));
    expect(await probeBlobReadiness(head, ['a', 'b', 'a'])).toEqual({ a: 'ready', b: 'ready' });
    expect(head).toHaveBeenCalledTimes(2);
    for (const [, signal] of head.mock.calls) expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps the headers of a still-processing 503', async () => {
    const head: BlobHead = async () =>
      answer(503, { 'retry-after': '5', 'x-scan-status': 'Pending' });
    expect(await probeBlobReadiness(head, ['a'])).toEqual({ a: 'processing' });
  });

  it('counts a HEAD that times out as processing', async () => {
    const head: BlobHead = (_, signal) =>
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    expect(await probeBlobReadiness(head, ['a'], { timeoutMs: 10 })).toEqual({
      a: 'processing',
    });
  });

  it('counts any other error as ready, so it never holds Start', async () => {
    const head: BlobHead = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await probeBlobReadiness(head, ['a'])).toEqual({ a: 'ready' });
    const timedOut: BlobHead = async () => {
      throw timeout();
    };
    expect(await probeBlobReadiness(timedOut, ['a'])).toEqual({ a: 'processing' });
  });

  it('starts no HEAD past the deadline, leaving those blobs unread', async () => {
    const head = vi.fn<BlobHead>(async () => answer(204));
    let t = 0;
    const states = await probeBlobReadiness(head, ['a', 'b', 'c'], {
      deadlineMs: 5,
      now: () => (t += 3),
    });
    expect(Object.keys(states).length).toBeLessThan(3);
  });
});
