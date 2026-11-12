import { describe, expect, it, vi } from 'vitest';

const headBlob = vi.fn();
vi.mock('@civitai/orchestration-client', () => ({
  headBlob: (...args: unknown[]) => headBlob(...args),
}));

const { classifyBlobHead, probeBlobReadiness } = await import('./upload-readiness');

const head = (status: number, headers: Record<string, string> = {}) => ({
  response: { status, ok: status < 300, headers: new Headers(headers) },
});
const client = {} as Parameters<typeof probeBlobReadiness>[0];

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
    ['a 503 with no retry hint', 503, {}, 'failed'],
    ['an answer about something else', 401, {}, null],
  ] as const)('reads %s', (_, status, headers, want) => {
    expect(classifyBlobHead(status, new Headers(headers))).toBe(want);
  });
});

describe('probeBlobReadiness', () => {
  it('reads each blob once, without a workflowId, with a timeout', async () => {
    headBlob.mockReset();
    headBlob.mockResolvedValue(head(204));
    const states = await probeBlobReadiness(client, ['a', 'b', 'a']);
    expect(states).toEqual({ a: 'ready', b: 'ready' });
    expect(headBlob).toHaveBeenCalledTimes(2);
    for (const [opts] of headBlob.mock.calls) {
      expect(opts.query?.workflowId).toBeUndefined();
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('counts a HEAD that times out or throws as processing', async () => {
    headBlob.mockReset();
    headBlob.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
    );
    expect(await probeBlobReadiness(client, ['a'], { timeoutMs: 10 })).toEqual({
      a: 'processing',
    });
  });

  it('starts no HEAD past the deadline, leaving those blobs unread', async () => {
    headBlob.mockReset();
    headBlob.mockResolvedValue(head(204));
    let t = 0;
    const states = await probeBlobReadiness(client, ['a', 'b', 'c'], {
      deadlineMs: 5,
      now: () => (t += 3),
    });
    expect(Object.keys(states).length).toBeLessThan(3);
  });

  it('counts an answer that says nothing about readiness as ready, so the submit decides', async () => {
    headBlob.mockReset();
    headBlob.mockResolvedValue(head(401));
    expect(await probeBlobReadiness(client, ['a'])).toEqual({ a: 'ready' });
  });
});
