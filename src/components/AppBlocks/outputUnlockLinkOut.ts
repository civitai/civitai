/**
 * Where the output-unlock dialog sends a viewer whose site keeps an output out
 * (`link-out`): the SAME app on civitai.red, at the page they are on.
 *
 * Built only from what the HOST knows (the red domain from the server config, the app's run
 * slug and the current sub-path from the host's own route), never from anything the app sends.
 * The sub-path is rebuilt segment by segment: empty segments (`//`), `.` and `..` are dropped and
 * every kept segment is percent-encoded, so it can neither leave `/apps/run/<slug>/` nor carry a
 * query, a fragment or a second host. No host-owned query parameters are carried over.
 */
export function outputUnlockRedHref(opts: {
  redDomain: string;
  slug: string;
  subPath: string;
}): string {
  const segments = opts.subPath
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .map(encodeURIComponent);
  const base = `https://${opts.redDomain}/apps/run/${encodeURIComponent(opts.slug)}`;
  return segments.length > 0 ? `${base}/${segments.join('/')}` : base;
}
