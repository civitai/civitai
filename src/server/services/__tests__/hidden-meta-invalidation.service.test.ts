import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClientEnv from '~/env/client';
import type * as CloudflareClient from '~/server/cloudflare/client';
import type * as ImageDeliveryService from '~/server/services/image-delivery.service';
import type * as ImageService from '~/server/services/image.service';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const LOC = 'https://image.example.test/abcdEFGH';

const mocks = vi.hoisted(() => ({
  bust: vi.fn(),
  purgeResizeCache: vi.fn(),
  purgeCache: vi.fn(),
}));

vi.mock('~/env/client', async (importOriginal) => {
  const actual = await importOriginal<typeof ClientEnv>();
  return { ...actual, env: { ...actual.env, NEXT_PUBLIC_IMAGE_LOCATION: LOC } };
});
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

const { invalidateHiddenImageMetadata } = await import(
  '~/server/services/hidden-meta-invalidation.service'
);
const { getImageEdgePurgeUrls } = await import('~/server/services/image-edge-purge');

const ID = 4242;
const KEY = '0b7f5e7c-1d1a-4c3e-9f55-2a4d1c0e9b11';
const NAME = 'sunset portrait.png';
const IMAGE = { id: ID, url: KEY, name: NAME };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Resolves 'held' if `p` is still pending after `ms`, so a regression reads as a value, not a hang. */
const within = <T>(p: Promise<T>, ms = 500) =>
  Promise.race([p, new Promise<'held'>((r) => setTimeout(() => r('held'), ms))]);

// The module loads image.service lazily; load it once up front so no test's timing includes it.
beforeAll(async () => {
  await import('~/server/services/image.service');
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bust.mockResolvedValue(undefined);
  mocks.purgeResizeCache.mockResolvedValue(undefined);
  mocks.purgeCache.mockResolvedValue(undefined);
});

describe('invalidateHiddenImageMetadata — order', () => {
  it('holds the save until the delivery-cache bust resolves', async () => {
    const bust = deferred();
    mocks.bust.mockReturnValue(bust.promise);

    let settled = false;
    const done = invalidateHiddenImageMetadata(IMAGE).then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    expect(mocks.purgeResizeCache).not.toHaveBeenCalled();

    bust.resolve();
    await done;
    await vi.waitFor(() =>
      expect(mocks.purgeResizeCache).toHaveBeenCalledWith(
        expect.objectContaining({ url: KEY, scope: 'hidden-meta-orphans' })
      )
    );
    await vi.waitFor(() => expect(mocks.purgeCache).toHaveBeenCalledTimes(1));
  });

  it('does not hold the save for the cache service purge', async () => {
    mocks.purgeResizeCache.mockReturnValue(new Promise(() => undefined));

    expect(await within(invalidateHiddenImageMetadata(IMAGE))).toBeUndefined();
  });

  it('purges the CDN only after the cache service purge resolves', async () => {
    const purge = deferred();
    mocks.purgeResizeCache.mockReturnValue(purge.promise);

    expect(await within(invalidateHiddenImageMetadata(IMAGE))).toBeUndefined();
    await vi.waitFor(() => expect(mocks.purgeResizeCache).toHaveBeenCalledTimes(1));
    await flush();
    expect(mocks.purgeCache).not.toHaveBeenCalled();

    purge.resolve();
    await vi.waitFor(() =>
      expect(mocks.purgeCache).toHaveBeenCalledWith({ urls: getImageEdgePurgeUrls(IMAGE) })
    );
  });

  it('gives the cache service about a minute, not the default two seconds', async () => {
    await invalidateHiddenImageMetadata(IMAGE);

    await vi.waitFor(() => expect(mocks.purgeCache).toHaveBeenCalledTimes(1));
    expect(mocks.purgeResizeCache.mock.calls[0][0].waitForInvalidationMs).toBeGreaterThanOrEqual(
      60_000
    );
  });

  it('logs, and rejects nothing, when the detached CDN purge fails', async () => {
    mocks.purgeCache.mockRejectedValue(new Error('cf down'));

    await expect(invalidateHiddenImageMetadata(IMAGE)).resolves.toBeUndefined();
    await vi.waitFor(() =>
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'hidden-meta-invalidation', imageKey: KEY })
      )
    );
  });
});

describe('getImageEdgePurgeUrls', () => {
  const urls = getImageEdgePurgeUrls(IMAGE);

  // Literals, as the image detail page and the image cards request them.
  it.each([
    `${LOC}/${KEY}/original=true/sunset%20portrait.jpeg`,
    `${LOC}/${KEY}/anim=false,original=true/sunset%20portrait.jpeg`,
    `${LOC}/${KEY}/anim=false,width=450,optimized=true/sunset%20portrait.jpeg`,
    `${LOC}/${KEY}/width=450,optimized=true/sunset%20portrait.jpeg`,
    `${LOC}/${KEY}/anim=false,width=1800,optimized=true/sunset%20portrait.jpeg`,
    `${LOC}/${KEY}/original=true/${ID}.jpeg`,
    `${LOC}/${KEY}/anim=false,width=450,optimized=true/${ID}.jpeg`,
    `${LOC}/${KEY}/original=true/${KEY}.jpeg`,
    `${LOC}/${KEY}/width=320/${KEY}.jpeg`,
  ])('includes %s', (expected) => {
    expect(urls).toContain(expected);
  });

  it('percent-encodes a non-ASCII name the way a browser requests it', () => {
    expect(getImageEdgePurgeUrls({ id: ID, url: KEY, name: 'café 夜.png' })).toContain(
      `${LOC}/${KEY}/original=true/caf%C3%A9%20%E5%A4%9C.jpeg`
    );
  });

  it('only targets this image, once each', () => {
    expect(urls.every((u) => u.startsWith(`${LOC}/${KEY}/`))).toBe(true);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('purges the id-named urls the cards and detail page request', () => {
    expect(urls).toEqual(
      expect.arrayContaining([
        `${LOC}/${KEY}/original=true/${ID}.jpeg`,
        `${LOC}/${KEY}/anim=false,original=true/${ID}.jpeg`,
        `${LOC}/${KEY}/width=450/${ID}.jpeg`,
      ])
    );
  });

  it('covers the id and key names when the image has no name', () => {
    const unnamed = getImageEdgePurgeUrls({ id: ID, url: KEY, name: null });
    expect(unnamed).toContain(`${LOC}/${KEY}/original=true/${ID}.jpeg`);
    expect(unnamed).toContain(`${LOC}/${KEY}/original=true/${KEY}.jpeg`);
    expect(unnamed.length).toBeLessThan(urls.length);
  });
});
