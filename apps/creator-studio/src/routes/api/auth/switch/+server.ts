import { error } from '@sveltejs/kit';
import {
  createDeviceAccountClient,
  parseCookieHeader,
  readDeviceId,
  sessionCookieMode,
  spokeSessionCookies,
} from '@civitai/auth';
import type { RequestHandler } from './$types';

// Switch this browser's session on THIS app to another account on this device. The hub's POST /api/auth/switch
// is the sole authority: it re-checks the active session and requires the target to be linked to this device
// (else 403), then returns a fresh token. This app sets that token as its own cookie, in its own cookie mode; it
// never relays the hub's Set-Cookie, and never mints or sets a session for a client-supplied userId.
const deviceAccounts = createDeviceAccountClient();

export const POST: RequestHandler = async ({ request, url, locals }) => {
  if (!locals.user) throw error(401, 'Sign in first.');

  const body = (await request.json().catch(() => null)) as { userId?: unknown } | null;
  const userId = Number(body?.userId);
  if (!Number.isInteger(userId) || userId <= 0) throw error(400, 'Invalid account.');

  const cookie = request.headers.get('cookie') ?? '';
  const result = await deviceAccounts.switch(cookie, userId);
  // The hub declined: the target isn't linked to this device, has aged out, or the hub is unreachable.
  if (!result) throw error(403, 'Could not switch to that account.');

  const jar = parseCookieHeader(cookie);
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const c of spokeSessionCookies(result.token, {
    slot: sessionCookieMode(),
    hostname: url.hostname,
    deviceId: readDeviceId(jar)?.value,
    requestCookies: jar,
  })) {
    headers.append('set-cookie', c);
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
};
