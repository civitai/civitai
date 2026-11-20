import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setImageLevelAsModerator } from './main-app';

const fetchMock = vi.fn<typeof fetch>();
const COOKIE = 'civ-token=very-secret-session';

beforeEach(() => {
  process.env.CIVITAI_APP_URL = 'https://main.example/';
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  delete process.env.CIVITAI_APP_URL;
});

describe('setImageLevelAsModerator', () => {
  it("posts the level to the moderator rating endpoint with the moderator's own cookie", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ count: 1 }), { status: 200 }));

    expect(await setImageLevelAsModerator({ cookie: COOKIE, imageId: 12, level: 8 })).toEqual({
      ok: true,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://main.example/api/mod/image/set-nsfw-level');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('cookie')).toBe(COOKIE);
    expect(JSON.parse(String(init?.body))).toEqual({ items: [{ imageId: 12, nsfwLevel: 8 }] });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends nothing without a session to forward', async () => {
    expect(await setImageLevelAsModerator({ cookie: null, imageId: 12, level: 8 })).toEqual({
      ok: false,
      reason: 'no-session',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a refusal', () => Promise.resolve(new Response('no', { status: 403 }))],
    ['a timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
  ])('throws on %s, without the cookie in the message', async (_label, reply) => {
    fetchMock.mockImplementation(reply);
    const error = await setImageLevelAsModerator({ cookie: COOKIE, imageId: 12, level: 8 }).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain('very-secret-session');
  });
});
