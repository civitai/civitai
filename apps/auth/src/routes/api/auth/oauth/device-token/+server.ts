import { type RequestHandler } from '@sveltejs/kit';
import { deviceTokenGrant } from '$lib/server/oauth/device-token';
import { parseBody, setWildcardCors } from '$lib/server/oauth/http';

// POST /api/auth/oauth/device-token — device-flow token poll. Ported from device-token.ts.

export const OPTIONS: RequestHandler = () => {
  const headers = new Headers();
  setWildcardCors(headers);
  return new Response(null, { status: 204, headers });
};

export const POST: RequestHandler = async ({ request }) =>
  deviceTokenGrant(request, await parseBody(request));
