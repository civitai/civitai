import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchBlob } from '~/utils/file-utils';

/**
 * Pins the credential behavior of the shared media-fetch primitive.
 *
 * `fetchBlob` is fetched by every caller that pulls media bytes client-side:
 * orchestrator/consumer blobs, the image CDN, and — through form value URLs
 * (stored image meta, the `?gen=` handoff, pasted/dropped URLs) — URLs chosen
 * by attackers. Those fetches must never ride the victim's session cookies:
 * under the browser default (`credentials: 'same-origin'`) an app-origin URL
 * would carry them. Every legit caller is cross-origin (presigned blobs, CDN),
 * so `credentials: 'omit'` is behavior-preserving for them and closes the
 * credential class for the attacker-chosen ones. ClickUp 868maend5.
 */
const fetchMock = vi.fn();

describe('fetchBlob — fetch credentials', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response(new Blob(['bytes']), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends credentials: omit for an app-origin URL', async () => {
    await fetchBlob('https://civitai.com/private-endpoint.png');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];
    expect(options.credentials).toBe('omit');
  });

  it('passes the same options for a cross-origin orchestrator URL (behavior preserved)', async () => {
    const url = 'https://orchestration.civitai.com/v1/consumer/blobs/abc?sig=sig&exp=123';
    await fetchBlob(url);

    const [calledUrl, options] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(url);
    expect(options.credentials).toBe('omit');
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('short-circuits a Blob input without calling fetch', async () => {
    const blob = new Blob(['bytes']);
    const out = await fetchBlob(blob);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out).toBe(blob);
  });
});
