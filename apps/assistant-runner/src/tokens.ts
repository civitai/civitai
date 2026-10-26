import { createPublicKey, type KeyObject } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import { jwtVerify, type JWTPayload } from 'jose';

import type { Authenticator } from './interfaces';

/**
 * The two credentials civitai signs for the runner (`src/server/services/app-assistant/
 * assistant-runner-tokens.ts` on the civitai side). Both are ES256 JWTs from one key pair: civitai
 * holds the private key and the runner only the public one, so the runner can verify both and forge
 * neither. Each kind has its own `aud` and `typ`, so one is never accepted as the other.
 *
 * - The viewer token says who a run-API request acts for (`Authorization: Bearer`), about 5 minutes.
 * - The run grant lets the runner mint tokens for that viewer while it is live (about 2 h 10 min):
 *   the runner trades it, with its own secret, for short-lived tokens at civitai. Those tokens are
 *   the user's, user-wide, as the browser's are; the conversation and idempotency key it names are
 *   checked by the runner at start (and the conversation at a patch), not by civitai's mint.
 *   A preview grant is a run grant with `use: 'preview'`, valid about 2 minutes, for one Restart
 *   preview (`preview: true` below); the runner takes it for nothing else, and takes no other grant
 *   for that.
 */
export const TOKEN_ISSUER = 'civitai';
export const TOKEN_ALGORITHM = 'ES256';
export const VIEWER_AUDIENCE = 'assistant-runner:viewer';
export const VIEWER_TYP = 'assistant-viewer+jwt';
export const GRANT_AUDIENCE = 'assistant-runner:run-grant';
export const GRANT_TYP = 'assistant-run-grant+jwt';
/** The request header a start (and a patch) carries its run grant in. */
export const GRANT_HEADER = 'x-run-grant';
/** How far apart civitai's clock and the runner's may be. */
export const CLOCK_SKEW_SECONDS = 30;

/** A run grant that verified: who it acts for, in which conversation, for which start, until when. */
export interface VerifiedGrant {
  /** The grant itself, as civitai signed it: what the runner trades for tokens. */
  token: string;
  userId: string;
  conversationId: string;
  idempotencyKey: string;
  /** The grant's own id (`jti`). */
  id: string;
  expiresAt: Date;
  /** civitai says the viewer may start read-only subagents (claim `subagents: true`). */
  subagents: boolean;
  /**
   * A preview grant (claim `use: 'preview'`): civitai signs one, short-lived, for the page's Restart
   * preview. It is good only for that request (`POST apps/:app/preview`), and a run grant is not.
   */
  preview: boolean;
}

export interface TokenVerifier {
  /** The user a viewer token names, or `null` when it is not a valid, current viewer token. */
  viewer(token: string): Promise<string | null>;
  /** The run grant, or `null` when it is not a valid, current run grant. */
  grant(token: string): Promise<VerifiedGrant | null>;
}

/** Verifies civitai's viewer tokens and run grants with civitai's public key (SPKI PEM). */
export function createTokenVerifier(publicKeyPem: string): TokenVerifier {
  const key: KeyObject = createPublicKey(publicKeyPem);
  const verify = async (
    token: string,
    audience: string,
    typ: string
  ): Promise<JWTPayload | null> => {
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: [TOKEN_ALGORITHM],
        issuer: TOKEN_ISSUER,
        audience,
        typ,
        clockTolerance: CLOCK_SKEW_SECONDS,
        requiredClaims: ['sub', 'exp', 'iat'],
      });
      return payload;
    } catch {
      return null;
    }
  };
  return {
    async viewer(token) {
      const payload = await verify(token, VIEWER_AUDIENCE, VIEWER_TYP);
      return nonEmpty(payload?.sub) ?? null;
    },
    async grant(token) {
      const payload = await verify(token, GRANT_AUDIENCE, GRANT_TYP);
      if (!payload) return null;
      const userId = nonEmpty(payload.sub);
      const conversationId = nonEmpty(payload.cid);
      const idempotencyKey = nonEmpty(payload.key);
      const id = nonEmpty(payload.jti);
      if (!userId || !conversationId || !idempotencyKey || !id || !payload.exp) return null;
      return {
        token,
        userId,
        conversationId,
        idempotencyKey,
        id,
        expiresAt: new Date(payload.exp * 1000),
        subagents: payload.subagents === true,
        preview: payload.use === 'preview',
      };
    },
  };
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The viewer, from a civitai viewer token in `Authorization: Bearer`. Reads that header only: a
 * cookie, a query string or any other header is never read, so a browser's civitai session never
 * reaches the runner as a credential.
 */
export function viewerAuthenticator(verifier: TokenVerifier): Authenticator {
  return {
    async authenticate(headers: IncomingHttpHeaders) {
      const match = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(headers.authorization ?? '');
      const userId = match ? await verifier.viewer(match[1]!) : null;
      return userId ? { ok: true, userId } : { ok: false, status: 401, message: 'Sign in again.' };
    },
  };
}

/** The run grant a request carries, if any (the first, when a client sent it twice). */
export function grantHeader(headers: IncomingHttpHeaders): string | undefined {
  const value = headers[GRANT_HEADER];
  const grant = Array.isArray(value) ? value[0] : value;
  return grant ? grant.trim() : undefined;
}
