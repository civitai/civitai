import { describe, expect, it, vi } from 'vitest';
import { resolveSharedArticleRequest } from '~/server/services/article-share.page';

const TOKEN = 'a'.repeat(43);
const ARTICLE = 12;
const NOW = Date.UTC(2026, 10, 6);

function response() {
  const headers = new Map<string, unknown>();
  return {
    headers,
    res: {
      getHeader: (name: string) => headers.get(name.toLowerCase()),
      setHeader: (name: string, value: unknown) => headers.set(name.toLowerCase(), value),
    } as never,
  };
}

const resolve = (key: string, opened: { articleId: number; expiresAt: Date } | null = null) => {
  const { res, headers } = response();
  const open = vi.fn(async () => opened);
  return resolveSharedArticleRequest({ key, res, open, now: NOW }).then((result) => ({
    result,
    headers,
    open,
  }));
};

describe('the shared article link page', () => {
  it('trades a live token for a cookie on its article and redirects off the token URL', async () => {
    const { result, headers } = await resolve(TOKEN, {
      articleId: ARTICLE,
      expiresAt: new Date(NOW + 3600_000),
    });
    expect(result).toEqual({
      redirect: { destination: `/articles/shared/${ARTICLE}`, permanent: false },
    });
    const [cookie] = headers.get('set-cookie') as string[];
    expect(cookie).toMatch(new RegExp(`^__Host-civ-article-share-${ARTICLE}=${TOKEN};`));
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Max-Age=3600');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
  });

  it.each([
    ['unknown, expired or revoked', TOKEN],
    ['not a token at all', 'not-a-token'],
  ])('answers a %s key exactly alike: no cookie, no article id', async (_, key) => {
    const { result, headers } = await resolve(key);
    expect(result).toEqual({
      redirect: { destination: '/articles/shared/unavailable', permanent: false },
    });
    expect(headers.get('set-cookie')).toBeUndefined();
  });

  it('serves the draft page with nothing about the draft in it', async () => {
    const { result, open } = await resolve(String(ARTICLE));
    // The head is rendered from these props alone; the draft arrives after load.
    expect(result).toEqual({ props: { articleId: ARTICLE }, suppressAds: true });
    expect(open).not.toHaveBeenCalled();
  });

  it.each([TOKEN, String(ARTICLE), 'unavailable'])(
    'never lets a cache keep or a crawler index %s',
    async (key) => {
      const { headers } = await resolve(key);
      expect(headers.get('cache-control')).toBe('private, no-store');
      expect(headers.get('x-robots-tag')).toBe('noindex, nofollow');
    }
  );

  it.each([TOKEN, 'not-a-token'])('sends no Referer from the token URL %s', async (key) => {
    const { headers } = await resolve(key);
    expect(headers.get('referrer-policy')).toBe('no-referrer');
  });

  // no-referrer on the rendered page strips Origin from its own tRPC calls, which the API rejects.
  it.each([String(ARTICLE), 'unavailable'])(
    'keeps the Referer same-origin on the rendered page %s',
    async (key) => {
      const { headers } = await resolve(key);
      expect(headers.get('referrer-policy')).toBe('same-origin');
    }
  );
});
