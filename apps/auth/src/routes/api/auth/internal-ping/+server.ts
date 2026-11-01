import type { RequestHandler } from './$types';
import { isInternalRequest } from '$lib/server/auth/internal';

// GET /api/auth/internal-ping — answers 204 only to a caller presenting the hub's service credential, so each
// app can probe that its own copy still matches (the `auth_internal_parity` gauge). Touches no session.
export const GET: RequestHandler = ({ request }) =>
  new Response(null, { status: isInternalRequest(request) ? 204 : 401 });
