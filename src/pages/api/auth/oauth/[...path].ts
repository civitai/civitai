import type { NextApiRequest, NextApiResponse } from 'next';

// The OAuth/OIDC provider moved to the hub (auth.civitai.com). The old civitai.com/api/auth/oauth/*
// URLs route through here so pre-cutover third-party clients keep working WITHOUT any change on their end.
//
//   - `authorize` (browser navigation) → 308 REDIRECT: the user must land on the hub to log in / consent,
//     and the hub's relative redirects (/login, /login/oauth/authorize) have to resolve on the hub origin.
//   - everything else (token / revoke / userinfo / device* / session) → transparent reverse PROXY: the
//     request reaches the hub with its method, body, AND headers intact.
//
// WHY proxy the machine endpoints instead of a 308: a 308 to auth.civitai.com is CROSS-ORIGIN, which
//   (a) not every OAuth HTTP client follows on a POST (some drop the body, some don't follow at all), and
//   (b) makes clients STRIP the `Authorization` header (per the Fetch/HTTP spec — sensitive headers are
//       removed on cross-origin redirects), breaking `client_secret_basic` (token/revoke) and `Bearer`
//       (userinfo) auth → `invalid_client` / 401.
// Both silently broke pre-cutover integrations that POST client creds to civitai.com (esp. once their
// short-lived access tokens expired and they were forced onto the refresh path). Proxying keeps
// civitai.com responding exactly as it did before the cutover: a real 2xx/4xx, headers preserved, no
// redirect to follow.

// Raw body — we forward the bytes to the hub unchanged, so Next must not parse/consume them first.
export const config = { api: { bodyParser: false } };

const HUB = (process.env.AUTH_JWT_ISSUER ?? '').replace(/\/+$/, '');
const PROXY_TIMEOUT_MS = 15_000;

// Only browser-navigation endpoints redirect; every other oauth path is an API call and is proxied.
const REDIRECT_ENDPOINTS = new Set(['authorize']);

// Hop-by-hop headers must not cross the proxy boundary (RFC 7230 §6.1). content-length/encoding are
// recomputed by fetch (request) / Next (response), so drop the inbound values.
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
]);
const STRIP_RESPONSE_HEADERS = new Set([
  'connection',
  'transfer-encoding',
  'keep-alive',
  'content-length',
  'content-encoding', // fetch already decoded the body (arrayBuffer), so the stored encoding is stale
]);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!HUB || !req.url) {
    res.status(500).json({ error: 'server_error', error_description: 'OAuth hub not configured' });
    return;
  }

  const segments = req.query.path;
  const endpoint = (Array.isArray(segments) ? segments[0] : segments) ?? '';
  const target = `${HUB}${req.url}`;

  // Browser flow → redirect (308 preserves method + body; the browser follows transparently).
  if (REDIRECT_ENDPOINTS.has(endpoint)) {
    res.redirect(308, target);
    return;
  }

  // Server-to-server → transparent reverse proxy.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  try {
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const body = hasBody ? await readRawBody(req) : undefined;

    // Forward all headers EXCEPT hop-by-hop ones — crucially Authorization/Cookie survive (same-origin
    // hop, so nothing strips them), which is the whole point of proxying over redirecting. cf-connecting-ip
    // / x-forwarded-for ride along so the hub's rate limiter still sees the real client IP.
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value == null || STRIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
      headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }

    const hubRes = await fetch(target, {
      method: req.method,
      headers,
      // Node Buffer is a valid fetch body at runtime (undici); the DOM `BodyInit` type just doesn't model it.
      body: body && body.length ? (body as unknown as BodyInit) : undefined,
      redirect: 'manual',
      signal: controller.signal,
    });

    res.status(hubRes.status);
    // Set-Cookie can be multi-valued — relay it as an array, not a comma-joined string.
    const setCookies = hubRes.headers.getSetCookie?.() ?? [];
    if (setCookies.length) res.setHeader('set-cookie', setCookies);
    hubRes.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'set-cookie' || STRIP_RESPONSE_HEADERS.has(key.toLowerCase()))
        return;
      res.setHeader(key, value);
    });
    res.send(Buffer.from(await hubRes.arrayBuffer()));
  } catch (err) {
    const aborted = (err as Error)?.name === 'AbortError';
    res.status(aborted ? 504 : 502).json({
      error: 'server_error',
      error_description: aborted ? 'OAuth hub timed out' : 'OAuth hub proxy failed',
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Buffer the raw request body (bodyParser is disabled) so it can be forwarded to the hub byte-for-byte. */
function readRawBody(req: NextApiRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
