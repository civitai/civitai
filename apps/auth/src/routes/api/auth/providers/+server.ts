import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listEnabledProviders } from '$lib/server/auth/providers';

// GET /api/auth/providers — the OAuth providers the hub can actually use (their CLIENT_ID/SECRET are present).
// The hub is the SINGLE source of provider config + secrets; spokes fetch this (server-to-server) to render
// their "Connect account" UI instead of holding provider secrets themselves. The response is public and carries
// NO secrets — provider ids + display names only. Short cache: the set changes only when hub config changes.
export const GET: RequestHandler = () =>
  json(
    { providers: listEnabledProviders() },
    { headers: { 'cache-control': 'public, max-age=300' } }
  );
