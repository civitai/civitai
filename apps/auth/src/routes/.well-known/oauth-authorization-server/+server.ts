import { json, type RequestHandler } from '@sveltejs/kit';
import { authorizationServerMetadata, DISCOVERY_HEADERS } from '$lib/server/oauth/discovery';

// GET /.well-known/oauth-authorization-server — RFC 8414 metadata, the same document as
// /.well-known/openid-configuration.
export const GET: RequestHandler = ({ url }) =>
  json(authorizationServerMetadata(url), { headers: DISCOVERY_HEADERS });
