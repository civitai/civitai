import fs from 'fs';
import path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import { getCookies } from 'cookies-next';
import type { ShellRouteName } from '~/server/shell/shell-mode';
import { shellRouteByName } from '~/server/shell/shell-mode';
import { SHELL_RENDER_HEADER } from '~/shared/constants/shell.constants';

/**
 * What a static shell response carries, and the route cookie that opts a viewer into it.
 *
 * The shell is the same bytes for everyone, so its response may be cached at the edge
 * (`Cloudflare-CDN-Cache-Control`, read by Cloudflare only) but never by a browser or another
 * shared cache (`Cache-Control: private, no-store`), and must set no cookie: a cached Set-Cookie
 * would be handed to every viewer. Only a shell render gets these headers.
 */

export const SHELL_CACHE_CONTROL = 'private, no-store';
export const SHELL_CDN_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=30';
export const SHELL_CDN_CACHE_CONTROL_HEADER = 'Cloudflare-CDN-Cache-Control';

let buildId: string | undefined;

/** This build's id, as Next wrote it next to the build. `unknown` when there is no build (tests, dev). */
export function shellBuildId(): string {
  if (buildId === undefined) {
    try {
      const file = path.resolve(process.cwd(), process.env.NEXT_DIST_DIR || '.next', 'BUILD_ID');
      const value = fs.readFileSync(file, 'utf8').trim();
      buildId = /^[\w-]+$/.test(value) ? value : 'unknown';
    } catch {
      buildId = 'unknown';
    }
  }
  return buildId;
}

/** The purge tags: every shell, this route's shells, and this build's. */
export function shellCacheTag(route: ShellRouteName) {
  return `shell,shell-${route},build-${shellBuildId()}`;
}

export function applyShellResponseHeaders(res: ServerResponse, route: ShellRouteName) {
  res.setHeader('Cache-Control', SHELL_CACHE_CONTROL);
  res.setHeader(SHELL_CDN_CACHE_CONTROL_HEADER, SHELL_CDN_CACHE_CONTROL);
  res.setHeader('Cache-Tag', shellCacheTag(route));
  res.setHeader(SHELL_RENDER_HEADER, 'shell');
  // MUTATION M2
}

const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 7;

function appendSetCookie(res: ServerResponse, cookie: string) {
  const existing = res.getHeader('Set-Cookie');
  const all = Array.isArray(existing)
    ? existing.map(String)
    : existing != null
    ? [String(existing)]
    : [];
  res.setHeader('Set-Cookie', [...all, cookie]);
}

/**
 * Keeps the route cookie in step with the viewer's flag, from a PRIVATE response only (a full
 * render, the page-data endpoint): set while the flag is on, cleared once it is off. `refresh`
 * re-sets a cookie that is already there, to extend it. Appends, so a session cookie the same
 * response rolls is kept.
 */
export function syncShellRouteCookie(
  req: IncomingMessage,
  res: ServerResponse,
  route: ShellRouteName,
  enabled: boolean,
  { refresh = false }: { refresh?: boolean } = {}
) {
  const { cookie } = shellRouteByName(route);
  const present = getCookies({ req: req as never })[cookie] !== undefined;
  if (enabled && (refresh || !present)) {
    appendSetCookie(res, `${cookie}=1; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; Secure; SameSite=Lax`);
  } else if (!enabled && present) {
    appendSetCookie(res, `${cookie}=; Path=/; Max-Age=0; Secure; SameSite=Lax`);
  }
}
