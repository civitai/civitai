import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CloudflareClient from '~/server/cloudflare/client';
import type * as ImageDeliveryService from '~/server/services/image-delivery.service';
import type * as ImageService from '~/server/services/image.service';
import { COMMON_IMAGE_WIDTHS, getEdgeUrl } from '~/client-utils/edge-url';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const mocks = vi.hoisted(() => ({
  bust: vi.fn(),
  purgeResizeCache: vi.fn(),
  purgeCache: vi.fn(),
}));

vi.mock('~/server/services/image-delivery.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageDeliveryService>()),
  bustImageDeliveryMetadataCache: mocks.bust,
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  purgeResizeCache: mocks.purgeResizeCache,
}));
vi.mock('~/server/cloudflare/client', async (importOriginal) => ({
  ...(await importOriginal<typeof CloudflareClient>()),
  purgeCache: mocks.purgeCache,
}));

const { getHiddenMetaPurgeUrls, invalidateHiddenImageMetadata } = await import(
  '~/server/services/hidden-meta-invalidation.service'
);

const KEY = '0b7f5e7c-1d1a-4c3e-9f55-2a4d1c0e9b11';
const NAME = 'sunset portrait.png';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bust.mockResolvedValue(undefined);
  mocks.purgeResizeCache.mockResolvedValue(undefined);
  mocks.purgeCache.mockResolvedValue(undefined);
});

describe('invalidateHiddenImageMetadata — order', () => {
  it('asks the cache service to purge only after the delivery-cache bust resolves', async () => {
    const bust = deferred();
    mocks.bust.mockReturnValue(bust.promise);

    const done = invalidateHiddenImageMetadata({ url: KEY, name: NAME });
    await flush();
    expect(mocks.purgeResizeCache).not.toHaveBeenCalled();
    expect(mocks.purgeCache).not.toHaveBeenCalled();

    bust.resolve();
    await done;
    expect(mocks.purgeResizeCache).toHaveBeenCalledWith(
      expect.objectContaining({ url: KEY, scope: 'hidden-meta-orphans' })
    );
  });

  it('purges the CDN only after the cache service purge resolves', async () => {
    const purge = deferred();
    mocks.purgeResizeCache.mockReturnValue(purge.promise);

    const done = invalidateHiddenImageMetadata({ url: KEY, name: NAME });
    await flush();
    expect(mocks.purgeResizeCache).toHaveBeenCalledTimes(1);
    expect(mocks.purgeCache).not.toHaveBeenCalled();

    purge.resolve();
    await done;
    expect(mocks.purgeCache).toHaveBeenCalledWith({
      urls: getHiddenMetaPurgeUrls({ url: KEY, name: NAME }),
    });
  });

  it('waits for the cache service to answer instead of only dispatching the request', async () => {
    await invalidateHiddenImageMetadata({ url: KEY, name: NAME });

    expect(mocks.purgeResizeCache).toHaveBeenCalledWith(
      expect.objectContaining({ waitForInvalidation: true })
    );
  });

  it('never rejects into the save, and logs, when the CDN purge fails', async () => {
    mocks.purgeCache.mockRejectedValue(new Error('cf down'));

    await expect(invalidateHiddenImageMetadata({ url: KEY, name: NAME })).resolves.toBeUndefined();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'hidden-meta-invalidation', imageKey: KEY })
    );
  });
});

describe('getHiddenMetaPurgeUrls', () => {
  const urls = getHiddenMetaPurgeUrls({ url: KEY, name: NAME });

  it('covers the original under both the image name and the key name', () => {
    expect(urls).toContain(getEdgeUrl(KEY, { name: NAME, original: true }));
    expect(urls).toContain(getEdgeUrl(KEY, { original: true }));
    expect(urls.some((u) => u.endsWith(`${KEY}/original=true/sunset portrait.jpeg`))).toBe(true);
    expect(urls.some((u) => u.endsWith(`${KEY}/original=true/${KEY}.jpeg`))).toBe(true);
  });

  it('covers every ladder width as the client requests it, under both names', () => {
    for (const width of COMMON_IMAGE_WIDTHS) {
      for (const name of [NAME, undefined]) {
        expect(urls).toContain(getEdgeUrl(KEY, { name, width, optimized: true }));
        expect(urls).toContain(getEdgeUrl(KEY, { name, width, anim: false, optimized: true }));
        expect(urls).toContain(getEdgeUrl(KEY, { name, width }));
      }
    }
  });

  it('only targets this image', () => {
    expect(urls.every((u) => u.includes(`/${KEY}/`) || u.startsWith(`${KEY}/`))).toBe(true);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('falls back to the key name alone when the image has no name', () => {
    const unnamed = getHiddenMetaPurgeUrls({ url: KEY, name: null });
    expect(unnamed).toContain(getEdgeUrl(KEY, { original: true }));
    expect(unnamed.length).toBeLessThan(urls.length);
  });
});
