import { json, type RequestHandler } from '@sveltejs/kit';
import { authorizationServerMetadata, DISCOVERY_HEADERS } from '$lib/server/oauth/discovery';

// GET /.well-known/openid-configuration — OIDC discovery. Ported from the main app's
// src/pages/api/.well-known/openid-configuration.ts. Authoritative now that the provider lives in the hub.
export const GET: RequestHandler = ({ url }) =>
  json(authorizationServerMetadata(url), { headers: DISCOVERY_HEADERS });
