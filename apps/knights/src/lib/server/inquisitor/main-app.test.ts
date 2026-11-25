import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionCookieName } from '@civitai/auth';
import { setImageLevelAsModerator } from './main-app';
import { OverrideWriteError } from './override-error';

const fetchMock = vi.fn<typeof fetch>();
const NAME = sessionCookieName();
const COOKIE = `other=1; ${NAME}=very-secret-session; theme=dark`;

beforeEach(() => {
  process.env.CIVITAI_APP_URL = 'https://main.example/';
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  delete process.env.CIVITAI_APP_URL;
});

const write = (cookie: string | null = COOKIE) =>
  setImageLevelAsModerator({ cookie, imageId: 12, level: 8 });

describe('setImageLevelAsModerator', () => {
  it("posts the level to the moderator rating endpoint with only the moderator's session cookie, never following a redirect", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ count: 1 }), { status: 200 }));

    expect(await write()).toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://main.example/api/mod/image/set-nsfw-level');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('cookie')).toBe(`${NAME}=very-secret-session`);
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(String(init?.body))).toEqual({
      items: [{ imageId: 12, nsfwLevel: 8 }],
      status: 'Actioned',
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('forwards the session segment exactly as the browser sent it, never decoded', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await write(`a=1; ${NAME}=tok%2Ben%3D; b=2`);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('cookie')).toBe(
      `${NAME}=tok%2Ben%3D`
    );
  });

  it.each([
    ['no cookie', null],
    ['no session among the cookies', 'other=1; theme=dark'],
  ])('sends nothing with %s', async (_label, cookie) => {
    expect(await write(cookie)).toEqual({ ok: false, reason: 'no-session' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a main app that is not https, except on a local host', async () => {
    process.env.CIVITAI_APP_URL = 'http://main.example';
    await expect(write()).rejects.toMatchObject({ ambiguous: false });
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.CIVITAI_APP_URL = 'http://localhost:3000';
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    expect(await write()).toEqual({ ok: true });
  });

  it.each([
    ['a refusal', () => Promise.resolve(new Response('no', { status: 403 })), false],
    ['a server error', () => Promise.resolve(new Response('no', { status: 502 })), true],
    ['a timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError')), true],
    ['a redirect', () => Promise.reject(new TypeError('redirect')), true],
  ])(
    'throws on %s, saying whether the level may have landed, without the cookie in the message',
    async (_label, reply, ambiguous) => {
      fetchMock.mockImplementation(reply);
      const error = await write().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OverrideWriteError);
      expect((error as OverrideWriteError).ambiguous).toBe(ambiguous);
      expect(String((error as Error).message)).not.toContain('very-secret-session');
    }
  );
});
