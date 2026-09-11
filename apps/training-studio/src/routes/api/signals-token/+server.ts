import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSignalsAccessToken } from '$lib/server/signals';

// The client's SignalR `accessTokenFactory` calls this on connect and on every reconnect, so a token
// expiring mid-session is re-minted transparently. Null (dev preview / signals off) => the client doesn't
// connect and falls back to polling.
export const GET: RequestHandler = async ({ locals }) => {
  if (locals.devPreview) return json({ accessToken: null });
  return json({ accessToken: await getSignalsAccessToken(locals.user.id) });
};
