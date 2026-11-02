export const WELCOME_PATH = '/welcome';

const DATA_SUFFIX = '/__data.json';
const INVALIDATED_PARAM = 'x-sveltekit-invalidated';

/**
 * The page to come back to after sign-in, from the untrusted `?next=`. Only a same-origin path survives:
 * one slash, then anything but a slash, backslash or control character (browsers read `/\` and `//` as a host).
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !/^\/(?![/\\])[^\\]*$/.test(raw)) return '/';
  if ([...raw].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return '/';
  if (/%(0[0-9a-f]|1[0-9a-f]|7f)/i.test(raw)) return '/';
  return raw.split(/[?#]/)[0] === WELCOME_PATH ? '/' : raw;
}

/** The page a request is really for: a client-side navigation arrives as `<page>/__data.json`. */
function wantedPath(url: URL): string {
  const params = new URLSearchParams(url.search);
  if (!url.pathname.endsWith(DATA_SUFFIX)) return url.pathname + url.search;
  params.delete(INVALIDATED_PARAM);
  const query = params.toString();
  return (url.pathname.slice(0, -DATA_SUFFIX.length) || '/') + (query ? `?${query}` : '');
}

/**
 * Where a signed-out request goes. A page load lands on the welcome screen, which holds the hub sign-in and
 * remembers the page; an API or non-page request keeps the guard's own redirect.
 */
export function signedOutLocation({
  url,
  navigation,
  loginRedirect,
}: {
  url: URL;
  navigation: boolean;
  loginRedirect: string;
}): string {
  if (!navigation || url.pathname === '/api' || url.pathname.startsWith('/api/')) return loginRedirect;
  const next = safeNext(wantedPath(url));
  return next === '/' ? WELCOME_PATH : `${WELCOME_PATH}?next=${encodeURIComponent(next)}`;
}
