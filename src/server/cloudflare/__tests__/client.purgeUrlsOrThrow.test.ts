import { beforeEach, describe, expect, it, vi } from 'vitest';
import { envMock } from '~/__tests__/mocks/env.mock';

const { mockCfPurge } = vi.hoisted(() => ({ mockCfPurge: vi.fn() }));
vi.mock('cloudflare', () => ({
  default: class {
    zones = { purgeCache: mockCfPurge };
  },
}));

// The client is built when the module loads, from these.
envMock.set({ CF_ZONE_ID: 'zone', CF_API_TOKEN: 'token' });
const { purgeUrlsOrThrow, CloudflarePurgeBusyError } = await import('~/server/cloudflare/client');

/** The client's HTTP error: a status on `statusCode`. */
const httpError = (statusCode: number) =>
  Object.assign(new Error(`Response code ${statusCode}`), { statusCode });
const rateLimited = () => httpError(429);
const urls = Array.from({ length: 250 }, (_, i) => `https://image.example/k/width=${i}/k.jpeg`);
const batches = () => mockCfPurge.mock.calls.map((c) => (c[1] as { files: string[] }).files);

describe('purgeUrlsOrThrow', () => {
  beforeEach(() => {
    mockCfPurge.mockReset().mockResolvedValue({ success: true });
  });

  it('purges every url, in order, in batches', async () => {
    await purgeUrlsOrThrow(urls);
    expect(batches().map((b) => b.length)).toEqual([100, 100, 50]);
    expect(batches().flat()).toEqual(urls);
  });

  it('still purges the later batches when one fails, then throws', async () => {
    mockCfPurge.mockRejectedValueOnce(new Error('429'));
    await expect(purgeUrlsOrThrow(urls)).rejects.toThrow('1 cloudflare purge batch(es) failed');
    expect(batches().flat()).toEqual(urls);
  });

  it('gives up on a batch that never answers, moves on, and reports busy', async () => {
    mockCfPurge.mockImplementationOnce(() => new Promise(() => undefined));
    await expect(purgeUrlsOrThrow(urls, { timeoutMs: 20 })).rejects.toBeInstanceOf(
      CloudflarePurgeBusyError
    );
    expect(batches()).toHaveLength(3);
  });

  it('stops at a 429 and reports busy', async () => {
    mockCfPurge.mockRejectedValueOnce(rateLimited());
    await expect(purgeUrlsOrThrow(urls)).rejects.toBeInstanceOf(CloudflarePurgeBusyError);
    expect(batches()).toHaveLength(1);
  });

  it('is not busy when any batch failed for another reason', async () => {
    mockCfPurge.mockRejectedValueOnce(httpError(500)).mockRejectedValueOnce(rateLimited());
    const error = await purgeUrlsOrThrow(urls).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).not.toBeInstanceOf(CloudflarePurgeBusyError);
  });
});
