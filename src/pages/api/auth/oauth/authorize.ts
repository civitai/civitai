import type { NextApiRequest, NextApiResponse } from 'next';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { Prisma } from '@prisma/client';
import { Request, Response } from '@node-oauth/oauth2-server';
import requestIp from 'request-ip';
import { oauthServer } from '~/server/oauth/server';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { dbRead, dbWrite } from '~/server/db/client';
import { addCorsHeaders } from '~/server/utils/endpoint-helpers';
import { checkOAuthRateLimit, sendRateLimitResponse } from '~/server/oauth/rate-limit';
import { logOAuthEvent } from '~/server/oauth/audit-log';
import { TokenScope, ALL_SCOPES } from '~/shared/constants/token-scope.constants';
import { buzzLimitSchema } from '~/server/schema/api-key.schema';
import { storeOidcContext } from '~/server/oauth/oidc-nonce';
import { redirectUriMatches } from '~/server/schema/oauth-client.schema';
import { isAppBlockOauthClientId } from '~/shared/constants/block-scope.constants';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 5xx attribution: bypasses the endpoint wrappers, so its 500s were
  // counter-blind. Listener-only (res.once('finish')); no behavior change.
  instrumentApiResponse(req, res);
  if (req.method === 'OPTIONS') {
    addCorsHeaders(req, res, ['GET', 'POST'], { allowCredentials: true });
    return;
  }

  // Consent approval MUST come via POST (from the consent form), not GET
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // User must be authenticated (via session cookie).
    // Use 303 so a POST from the consent form is downgraded to a GET to /login —
    // Next.js's res.redirect() defaults to 307 which would preserve the POST method.
    const session = await getServerAuthSession({ req, res });
    if (!session?.user) {
      const returnUrl = encodeURIComponent(req.url ?? '/');
      // Don't `return res.redirect(...)` — res.redirect returns the res
      // object, and a non-undefined handler return value triggers Next.js's
      // "API handler should not return a value, received object" warning.
      res.redirect(303, `/login?returnUrl=${returnUrl}`);
      return;
    }

    // Rate limit by user ID
    const allowed = await checkOAuthRateLimit(req, res, 'authorize', session.user.id.toString());
    if (!allowed) return sendRateLimitResponse(res);

    const params = req.method === 'GET' ? req.query : req.body;

    // Validate client exists
    const clientId = params.client_id as string;
    if (!clientId) {
      return res
        .status(400)
        .json({ error: 'invalid_request', error_description: 'Missing client_id' });
    }

    // SECURITY (audit A1): App-Blocks-provisioned OauthClients (`appblk-<slug>`)
    // exist solely as the policy ceiling for block-token minting. They must
    // NEVER drive the interactive authorization_code flow — that would let an
    // app-block owner mint a Full account Bearer token for any user they phish
    // into the consent screen (account takeover). Reject before the client is
    // even loaded so no app-block id can reach the authorize machinery. This
    // gate is scoped to `appblk-` ids only; genuine OAuth-apps clients (uuid
    // ids) are unaffected.
    if (isAppBlockOauthClientId(clientId)) {
      return res.status(400).json({
        error: 'invalid_client',
        error_description: 'This client cannot be used for interactive authorization',
      });
    }

    const client = await dbRead.oauthClient.findUnique({ where: { id: clientId } });
    if (!client) {
      return res
        .status(400)
        .json({ error: 'invalid_client', error_description: 'Unknown client_id' });
    }

    // Validate redirect_uri against registered URIs (exact, plus loopback port flexibility)
    const redirectUri = params.redirect_uri as string;
    if (!redirectUri || !redirectUriMatches(client.redirectUris, redirectUri)) {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'redirect_uri does not match any registered URI',
      });
    }

    // PKCE is required
    if (!params.code_challenge || !params.code_challenge_method) {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'PKCE required: provide code_challenge and code_challenge_method=S256',
      });
    }
    if (params.code_challenge_method !== 'S256') {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'Only S256 code_challenge_method is supported',
      });
    }

    // State is required (CSRF protection)
    if (!params.state) {
      return res
        .status(400)
        .json({ error: 'invalid_request', error_description: 'state parameter is required' });
    }

    // Validate and clamp scope
    const rawScope = parseInt(params.scope as string, 10);
    // Bound against ALL_SCOPES (incl. opt-in AppBlocksSubmit), NOT `Full`, so a
    // client may request an opt-in bit outside `Full`. The per-client
    // allowedScopes intersection (downstream) is the real authorization gate.
    if (isNaN(rawScope) || rawScope < 0 || rawScope > ALL_SCOPES) {
      return res
        .status(400)
        .json({ error: 'invalid_scope', error_description: 'Invalid scope value' });
    }
    // UserRead is a mandatory baseline on every grant — force it on so the
    // stored consent and consent screen reflect what the issued token carries.
    const requestedScope = rawScope | TokenScope.UserRead;

    // Check consent — approval MUST come via POST only (prevents CSRF/bypass via GET params)
    const isApproval = req.method === 'POST' && params.approved === 'true';

    const existingConsent = await dbRead.oauthConsent.findUnique({
      where: { userId_clientId: { userId: session.user.id, clientId } },
    });

    if (isApproval) {
      // User approved from the consent page — save consent if "remember" checked
      const shouldRemember = params.remember === 'true';

      // The consent screen optionally collects a buzz spend limit when the
      // requested scope includes AIServicesWrite. Body field is JSON-encoded
      // BuzzBudget[] (or empty for "no limit"); validate via the same schema
      // the rest of the codebase uses so a malformed input is rejected here
      // instead of silently corrupting the stored consent.
      let parsedBuzzLimit: Awaited<ReturnType<typeof buzzLimitSchema.parseAsync>> | null = null;
      const rawBuzzLimit = typeof params.buzz_limit === 'string' ? params.buzz_limit.trim() : '';
      if (rawBuzzLimit) {
        let json: unknown;
        try {
          json = JSON.parse(rawBuzzLimit);
        } catch {
          return res.status(400).json({
            error: 'invalid_request',
            error_description: 'buzz_limit is not valid JSON',
          });
        }
        const result = buzzLimitSchema.safeParse(json);
        if (!result.success) {
          return res.status(400).json({
            error: 'invalid_request',
            error_description: 'buzz_limit failed validation',
          });
        }
        parsedBuzzLimit = result.data;
      }

      if (shouldRemember) {
        await dbWrite.oauthConsent.upsert({
          where: { userId_clientId: { userId: session.user.id, clientId } },
          create: {
            userId: session.user.id,
            clientId,
            scope: requestedScope,
            buzzLimit: parsedBuzzLimit ?? Prisma.JsonNull,
          },
          update: { scope: requestedScope, buzzLimit: parsedBuzzLimit ?? Prisma.DbNull },
        });
      }
    } else if (!existingConsent || existingConsent.scope !== requestedScope) {
      // No prior consent (or scope changed) — redirect to consent page.
      // Use 303 so the browser always follows with GET, matching the consent
      // page's expectation of query-string params (regardless of how we arrived).
      const consentUrl = new URL('/login/oauth/authorize', process.env.NEXTAUTH_URL);
      for (const [key, value] of Object.entries(params)) {
        if (typeof value === 'string') consentUrl.searchParams.set(key, value);
      }
      res.redirect(303, consentUrl.toString());
      return;
    }

    // Issue authorization code
    const request = new Request({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      query: {},
      body: {
        ...params,
        response_type: 'code',
      },
    });

    const response = new Response(res);
    const code = await oauthServer.authorize(request, response, {
      authenticateHandler: {
        handle: () => ({ id: session.user!.id }),
      },
    });

    // OIDC: stash nonce + auth_time keyed by the code so /token can mint the id_token.
    // No-op unless the client passed a `nonce` (i.e. an OIDC "Sign in with Civitai" request).
    await storeOidcContext(code.authorizationCode, {
      nonce: typeof params.nonce === 'string' ? params.nonce : undefined,
      authTime: Math.floor(Date.now() / 1000),
    });

    const ip = requestIp.getClientIp(req) ?? '';
    logOAuthEvent({
      type: 'authorization.granted',
      userId: session.user!.id,
      clientId,
      scope: requestedScope,
      ip,
    });

    // Use validated redirect_uri (from our check, not raw params).
    // RFC 6749 §4.1.2 specifies a GET redirect back to the client. Next.js's
    // res.redirect() defaults to 307, which preserves the POST method and 405s
    // on standard OAuth callbacks that only define GET handlers — so force 303
    // to coerce the browser to GET the redirect_uri.
    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set('code', code.authorizationCode);
    redirectUrl.searchParams.set('state', params.state as string);
    res.redirect(303, redirectUrl.toString());
    return;
  } catch (err: any) {
    const status = err.statusCode || err.code || 500;
    return res.status(typeof status === 'number' ? status : 500).json({
      error: err.name || 'server_error',
      error_description: err.message,
    });
  }
}
