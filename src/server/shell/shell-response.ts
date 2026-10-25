import fs from 'fs';
import path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import { getCookies } from 'cookies-next';
import type { ShellRouteName } from '~/server/shell/shell-mode';
import { shellRouteByName } from '~/server/shell/shell-mode';
import { SHELL_EDGE_HEADERS, SHELL_RENDER_HEADER } from '~/shared/constants/shell.constants';

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
export const SHELL_CDN_CACHE_CONTROL_HEADER = SHELL_EDGE_HEADERS[0];

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

/** Before the shell renders (`getServerSideProps`): private to browsers, no cookie. */
export function applyShellPrivateHeaders(res: ServerResponse) {
  res.setHeader('Cache-Control', SHELL_CACHE_CONTROL);
  res.removeHeader('Set-Cookie');
}

/**
 * Only once the shell HAS rendered (`_document.getInitialProps`, which Next reaches after the page
 * rendered). Set earlier, they would survive a render that throws: Next renders `/_error` on the
 * same response and resets only Cache-Control (`renderErrorImpl` in `base-server.js`, 16.3.1), so a
 * per-viewer error page would go out edge-cacheable. `_app` also strips them on every non-shell run.
 */
export function applyShellEdgeHeaders(res: ServerResponse, route: ShellRouteName) {
  applyShellPrivateHeaders(res);
  res.setHeader(SHELL_CDN_CACHE_CONTROL_HEADER, SHELL_CDN_CACHE_CONTROL);
  res.setHeader('Cache-Tag', shellCacheTag(route));
  res.setHeader(SHELL_RENDER_HEADER, 'shell');
}

/**
 * A bounce off a shell route's canonical path (`~/server/shell/shell-canonical`): private, no
 * cookie, and none of the edge-cache headers — the edge must never store it, and a cookie on it
 * would be applied for a URL the browser never asked for.
 */
export function applyShellBounceHeaders(res: ServerResponse) {
  applyShellPrivateHeaders(res);
  for (const name of SHELL_EDGE_HEADERS) res.removeHeader(name);
  res.setHeader(SHELL_CDN_CACHE_CONTROL_HEADER, SHELL_CDN_CACHE_CONTROL);
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
