import { json } from '@sveltejs/kit';
import { createDeviceAccountClient } from '@civitai/auth';
import type { RequestHandler } from './$types';

// Proxy the hub's per-device account list (the civ-device Redis set). Display-only — the hub resolves
// username/image and requires an active session; it returns [] when there's no device set (single-account) or the
// caller is unauthorized. Same-origin so the browser's civ-token + civ-device cookies ride along.
export const GET: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return json({ accounts: [] });
  const cookie = request.headers.get('cookie') ?? '';
  const accounts = await createDeviceAccountClient().list(cookie);
  return json({ accounts });
};
