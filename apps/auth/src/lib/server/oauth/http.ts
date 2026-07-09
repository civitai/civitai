import { Request as OAuthRequest, Response as OAuthResponse } from '@node-oauth/oauth2-server';

// SvelteKit ↔ @node-oauth/oauth2-server adapter + CORS helpers. The library is framework-agnostic: it
// takes its own `Request` (a plain {method, headers, query, body} carrier) and returns the grant result
// directly, so we build that carrier from SvelteKit's web `Request` and read the RETURN value (the
// library's own `Response` object is an unused sink here, exactly as in the main app's Next handlers).

/**
 * Parse a SvelteKit request body into a plain object regardless of encoding. OAuth machine endpoints
 * (token / revoke / device / device-token) are `application/x-www-form-urlencoded` per spec; our own
 * verify page POSTs JSON (device-info / device-approve). Handle both; never throw (return {}).
 */
export async function parseBody(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      const json = await request.json();
      return json && typeof json === 'object' ? (json as Record<string, string>) : {};
    } catch {
      return {};
    }
  }
  try {
    const form = await request.formData();
    const obj: Record<string, string> = {};
    for (const [key, value] of form.entries()) obj[key] = typeof value === 'string' ? value : '';
    return obj;
  } catch {
    return {};
  }
}

/** Web `Headers` → plain record for the @node-oauth `Request` (it expects a lower-cased header map). */
export function headersToObject(headers: Headers): Record<string, string> {
  const obj: Record<string, string> = {};
  headers.forEach((value, key) => {
    obj[key] = value;
  });
  return obj;
}

/** Build the library's `Request` carrier. `headers`/`method`/`query` are mandatory (the ctor throws otherwise). */
export function toOAuthRequest(opts: {
  method: string;
  headers: Headers;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}): OAuthRequest {
  return new OAuthRequest({
    method: opts.method,
    headers: headersToObject(opts.headers),
    query: opts.query ?? {},
    body: opts.body ?? {},
  });
}

/** An unused response sink — the library populates it, but every handler here reads the return value instead. */
export function newOAuthResponse(): OAuthResponse {
  return new OAuthResponse({});
}

// ─── CORS ─────────────────────────────────────────────────────────────────────────────────────────
//
// The hub's hooks.server.ts only adds CORS for SAME-SITE spoke origins on its AUTH_CORS_ORIGINS
// allowlist; third-party OAuth client origins are not on that list, so these endpoints set their own
// CORS on the response. (When a first-party spoke eventually calls /token — Phase 3 — hooks would
// override Allow-Origin for that allowlisted origin; harmless, and revisited at that phase.)

/** Wildcard CORS for confidential / unknown / no-Origin (native) callers. Error bodies carry no token material. */
export function setWildcardCors(headers: Headers, methods = 'POST'): void {
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', methods);
  headers.set('Access-Control-Allow-Headers', '*');
}

/**
 * Per-origin CORS for a validated PUBLIC client. The browser Origin is the only signal that refuses a
 * code-exchange from an unregistered site after a code is intercepted, so we echo the EXACT origin —
 * only ever call this with an origin already re-validated against the client's `allowedOrigins`. No
 * `Access-Control-Allow-Credentials`: public OAuth clients use Bearer tokens, not cookies.
 */
export function setPublicClientCors(headers: Headers, origin: string, methods = 'POST'): void {
  headers.set('Access-Control-Allow-Origin', origin);
  headers.append('Vary', 'Origin');
  headers.set('Access-Control-Allow-Headers', '*');
  headers.set('Access-Control-Allow-Methods', methods);
}
