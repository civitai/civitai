import type { RequestHandler } from './$types';
import { canAccess } from '$lib/server/access';
import { HELD_MEDIA_PAGE } from '$lib/server/held-media';
import {
  issueCode,
  parseStartParams,
  type StartParams,
  webSessionClaims,
} from '$lib/server/held-sheet';

// The page and its redirect must not be framed, cached or sent on as a referrer.
// `form-action` names the callback's origin too: the confirmed form ends in a redirect to it.
const headers = (callback?: string) => ({
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  // Not no-referrer: under it the form POST carries `Origin: null`, which the origin check refuses.
  'referrer-policy': 'same-origin',
  'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${
    callback ? ` ${new URL(callback).origin}` : ''
  }; frame-ancestors 'none'; base-uri 'none'`,
});

const status = (code: number) => new Response(null, { status: code, headers: headers() });

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)
  );

function page(username: string, params: StartParams): string {
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Held media</title>
<style>body{font:16px system-ui,sans-serif;margin:0;padding:32px 16px;background:#1a1b1e;color:#e9ecef}
main{max-width:420px;margin:0 auto}button{font:inherit;padding:12px 20px;border:0;border-radius:8px;background:#228be6;color:#fff;width:100%}</style>
</head><body><main>
<h1>Open held media on your phone?</h1>
<p>Signed in as <strong>${escapeHtml(username)}</strong>.</p>
<form method="post">
${hidden('code_challenge', params.challenge)}
${hidden('code_challenge_method', 'S256')}
${hidden('state', params.state)}
${hidden('redirect_uri', params.redirect)}
<button type="submit">Continue</button>
</form>
</main></body></html>`;
}

/** Asks the moderator to confirm; issues nothing. */
export const GET: RequestHandler = ({ locals, url }) => {
  if (!locals.user || !canAccess(locals.user, HELD_MEDIA_PAGE)) return status(403);
  const params = parseStartParams((name) => url.searchParams.get(name));
  if (!params) return status(400);
  return new Response(page(locals.user.username ?? `#${locals.user.id}`, params), {
    headers: { ...headers(params.redirect), 'content-type': 'text/html; charset=utf-8' },
  });
};

/** The confirmed form: issues a code and sends it to the sheet. */
export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user || !canAccess(locals.user, HELD_MEDIA_PAGE)) return status(403);
  const form = await request.formData().catch(() => null);
  const params = form && parseStartParams((name) => form.get(name) as string | null);
  if (!params) return status(400);

  const claims = await webSessionClaims(request.headers.get('cookie') ?? '');
  if (!claims?.jti || Number(claims.sub) !== locals.user.id || claims.impersonatedBy != null)
    return status(403);

  const code = await issueCode(params, locals.user.id, claims).catch(() => null);
  if (!code) {
    console.error('[held-sheet] could not store a sign-in code');
    return status(503);
  }
  const location = `${params.redirect}?code=${code}&state=${encodeURIComponent(params.state)}`;
  return new Response(null, { status: 303, headers: { ...headers(params.redirect), location } });
};
