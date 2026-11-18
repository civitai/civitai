import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { mainAppAcceptLicense, mainAppPendingLicenses } from '$lib/server/main-app-license';
import { textCheckCookie } from '$lib/server/text-check';

// The base model licences a run must have accepted before it trains; the dev-login preview has no
// session to ask with, and its submits skip the check too.
export const GET: RequestHandler = async ({ locals, request }) => {
  const cookie = textCheckCookie(locals, request);
  if (cookie === null) return json({ pending: [] });
  try {
    return json({ pending: await mainAppPendingLicenses(cookie) });
  } catch (err) {
    error(502, (err as Error).message);
  }
};

export const POST: RequestHandler = async ({ locals, request }) => {
  const body = (await request.json().catch(() => null)) as { ecosystem?: unknown } | null;
  if (typeof body?.ecosystem !== 'string' || !body.ecosystem) error(400, 'Bad licence request.');
  const cookie = textCheckCookie(locals, request);
  if (cookie === null) return json({ ok: true });
  try {
    await mainAppAcceptLicense(cookie, body.ecosystem);
  } catch (err) {
    error(502, (err as Error).message);
  }
  return json({ ok: true });
};
