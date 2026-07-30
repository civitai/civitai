import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

// Switch the shared .civitai.com session to another account on THIS device. We proxy the hub's POST
// /api/auth/switch — which is the sole authority: it re-checks the active session and enforces the device-ownership
// guard (`isLinkedAndFresh`: the target userId must be in this device's fresh Redis set, else 403). We relay the
// hub's Set-Cookie verbatim, so the spoke never mints or sets a session for a client-supplied userId. Same-site
// (*.civitai.com ↔ hub) means the relayed Domain=.civitai.com session cookie is accepted by the browser.
const hubBase = () => (env.AUTH_HUB_INTERNAL_URL || env.AUTH_JWT_ISSUER || '').replace(/\/+$/, '');

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'Sign in first.');
  const base = hubBase();
  if (!base) throw error(500, 'Auth hub not configured.');

  const body = (await request.json().catch(() => null)) as { userId?: unknown } | null;
  const userId = Number(body?.userId);
  if (!Number.isInteger(userId) || userId <= 0) throw error(400, 'Invalid account.');

  const hubRes = await fetch(`${base}/api/auth/switch`, {
    method: 'POST',
    headers: { cookie: request.headers.get('cookie') ?? '', 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  // 403 = target not linked to this device / aged out; anything else non-2xx = the hub declined.
  if (!hubRes.ok)
    throw error(hubRes.status === 403 ? 403 : 400, 'Could not switch to that account.');

  // Relay the hub's session/device Set-Cookie headers to the browser unchanged.
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const c of hubRes.headers.getSetCookie()) headers.append('set-cookie', c);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
};
