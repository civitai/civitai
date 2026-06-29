import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db/db';
import { scopeLabels } from '$lib/server/oauth/scope';
import { resolvePendingDeviceCode } from '$lib/server/oauth/device-codes';
import { parseBody } from '$lib/server/oauth/http';

// POST /api/auth/oauth/device-info — session-gated lookup for the device verify page: given a user_code,
// returns the app name/logo + human-readable scope list.
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

  const { user_code } = await parseBody(request);
  if (!user_code) {
    return json({ error: 'invalid_request', error_description: 'Missing user_code' }, { status: 400 });
  }

  const resolved = await resolvePendingDeviceCode(user_code);
  if (!resolved.ok) {
    return json({ error: resolved.error, error_description: resolved.description }, { status: 400 });
  }

  const client = await db
    .selectFrom('OauthClient')
    .select(['name', 'description', 'logoUrl', 'isVerified'])
    .where('id', '=', resolved.data.clientId)
    .executeTakeFirst();
  if (!client) {
    return json({ error: 'invalid_code', error_description: 'Unknown application' }, { status: 400 });
  }

  return json({
    client: {
      name: client.name,
      description: client.description,
      logoUrl: client.logoUrl,
      isVerified: client.isVerified,
    },
    scopes: scopeLabels(parseInt(resolved.data.scope, 10) || 0),
  });
};
