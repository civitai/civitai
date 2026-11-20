import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSignalsAccessToken } from '$lib/server/live/signals';

// The SignalR client asks on every connect and reconnect, so an expired token is re-minted. Null keeps the page off signals.
export const GET: RequestHandler = async ({ locals }) =>
  json({ accessToken: await getSignalsAccessToken(locals.user.id) });
