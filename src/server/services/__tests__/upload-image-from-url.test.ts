import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { uploadImageFromUrl } = await import('~/server/services/image.service');

const TRUSTED = 'https://orchestration-new.civitai.com/v2/consumer/blobs/A.jpeg';
const TRUSTED_2 = 'https://orchestration.civitai.com/v2/consumer/blobs/B.jpeg';
const UNTRUSTED = 'https://169.254.169.254/latest/meta-data/';

const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } });

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const fetchedUrls = () => fetchMock.mock.calls.map(([url]) => url);

describe('uploadImageFromUrl', () => {
  it('fetches nothing from a url off the orchestrator hosts', async () => {
    await expect(uploadImageFromUrl({ imageUrl: UNTRUSTED })).rejects.toThrow(
      'Unsupported image url'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not follow a redirect to a url off the orchestrator hosts', async () => {
    fetchMock.mockResolvedValueOnce(redirectTo(UNTRUSTED));

    await expect(uploadImageFromUrl({ imageUrl: TRUSTED })).rejects.toThrow(
      'Unsupported image url'
    );
    expect(fetchedUrls()).toEqual([TRUSTED]);
  });

  it('follows a redirect between orchestrator urls, never automatically', async () => {
    fetchMock
      .mockResolvedValueOnce(redirectTo(TRUSTED_2))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    await uploadImageFromUrl({ imageUrl: TRUSTED }).catch(() => null);

    expect(fetchedUrls()).toEqual([TRUSTED, TRUSTED_2]);
    for (const [, init] of fetchMock.mock.calls) expect(init.redirect).toBe('manual');
  });

  it('refuses a fourth redirect', async () => {
    fetchMock.mockResolvedValue(redirectTo(TRUSTED_2));

    await expect(uploadImageFromUrl({ imageUrl: TRUSTED })).rejects.toThrow(
      'Unsupported image url'
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
