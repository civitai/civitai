import type { ServerResponse } from 'http';

/**
 * Adds `cookie` to the response's Set-Cookie list, keeping every entry already there. With
 * `replace`, first drops any entry for the same cookie name, so the response carries one for it:
 * two entries for one name leave the browser with whichever came last.
 */
export function appendSetCookie(
  res: ServerResponse,
  cookie: string,
  { replace = false }: { replace?: boolean } = {}
) {
  const existing = ([] as unknown[]).concat(res.getHeader('Set-Cookie') ?? []).map(String);
  const prefix = `${cookie.slice(0, cookie.indexOf('='))}=`;
  const kept = replace ? existing.filter((entry) => !entry.startsWith(prefix)) : existing;
  res.setHeader('Set-Cookie', [...kept, cookie]);
}
