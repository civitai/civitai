import { error } from '@sveltejs/kit';

/** Same-site pages share the session cookie, so a write must look like this app's own fetch: JSON,
 *  and same-origin when the browser says where it came from. SvelteKit's CSRF check covers form
 *  posts; JSON endpoints that write call this. */
export function assertOwnWrite(request: Request) {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') error(403, 'Cross-site request refused');
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json'))
    error(415, 'Send this request as application/json');
}
