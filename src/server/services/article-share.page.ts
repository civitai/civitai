import type { ServerResponse } from 'http';
import { isDev } from '~/env/other';
import { shareTokenSchema } from '~/server/schema/article.schema';
import { articleShareCookieName } from '~/server/services/article-share.helpers';

export const SHARED_UNAVAILABLE_KEY = 'unavailable';

type Opened = { articleId: number; expiresAt: Date } | null;

function appendSetCookie(res: ServerResponse, cookie: string) {
  const existing = res.getHeader('Set-Cookie');
  const all = existing ? (Array.isArray(existing) ? existing : [String(existing)]) : [];
  res.setHeader('Set-Cookie', [...all, cookie]);
}

/**
 * The server side of `/articles/shared/[key]`. A token key never renders: a live one becomes an
 * HttpOnly cookie for its article and a redirect to the article's shared page; anything else
 * redirects to the same "no longer available" page, so a dead token and an unknown one look alike.
 */
export async function resolveSharedArticleRequest({
  key,
  res,
  open,
  now = Date.now(),
}: {
  key: string;
  res: ServerResponse;
  open: (shareToken: string) => Promise<Opened>;
  now?: number;
}) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (/^[1-9]\d{0,9}$/.test(key))
    return { props: { articleId: Number(key) as number | null }, suppressAds: true };
  if (key === SHARED_UNAVAILABLE_KEY)
    return { props: { articleId: null as number | null }, suppressAds: true };

  const opened = shareTokenSchema.safeParse(key).success ? await open(key) : null;
  if (opened) {
    const maxAge = Math.max(0, Math.floor((new Date(opened.expiresAt).getTime() - now) / 1000));
    appendSetCookie(
      res,
      `${articleShareCookieName(
        opened.articleId
      )}=${key}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${isDev ? '' : '; Secure'}`
    );
  }
  return {
    redirect: {
      destination: `/articles/shared/${opened ? opened.articleId : SHARED_UNAVAILABLE_KEY}`,
      permanent: false,
    },
  };
}
