import { test as setup } from '@playwright/test';
import fs from 'fs';
import { SignJWT, importPKCS8, generateKeyPair, exportPKCS8 } from 'jose';
import { v4 as uuid } from 'uuid';
import { sessionCookieName } from '@civitai/auth';
import {
  HUB_USERS,
  type HubRole,
  storageStatePath,
  mintModePath,
  type MintMode,
} from './hub-fixtures';

/**
 * Hub e2e auth setup — the hub analog of the main app's tests/preview-auth.setup.ts.
 *
 * The hub's `/api/auth/dev/login` is double-gated to `vite dev`, so it is dead against a
 * production build (the deployed hub). Instead we mint the thin ES256 session JWS DIRECTLY
 * and write it as a Playwright `storageState` cookie — exactly as preview-auth.setup.ts mints
 * the NextAuth JWE directly with `encode()`. We sign with `jose` (the same lib the hub's
 * `@civitai/auth` signer uses) rather than importing the signer, so the harness doesn't inherit
 * the package's env-coupled config loading. The claim shape mirrors
 * `@civitai/auth` `mintSessionToken` EXACTLY: header `{alg:ES256,kid,typ:JWT}`, body
 * `{ sub, signedAt, iat, exp, jti, iss }` (see packages/civitai-auth/src/sign.ts).
 *
 * TRUSTED vs EPHEMERAL key (this is the load-bearing distinction the spec branches on):
 *   - If AUTH_JWT_PRIVATE_KEY (+ AUTH_JWT_KID/ISSUER) is provided AND it is the key the
 *     target hub actually verifies with, the minted cookie is TRUSTED → the hub's
 *     `GET /api/auth/identity` accepts it and the identity assertions run.
 *   - Otherwise we generate a throwaway ES256 keypair: the cookie is structurally valid but
 *     the hub will NOT verify it (unknown key) → identity assertions are SKIPPED, only the
 *     unauthenticated paths (health, JWKS, /login render) are asserted.
 * The mode is recorded to `mint-mode.json` so the spec can decide without re-deriving it.
 */

const HUB_URL = process.env.HUB_URL!;
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60; // 30d, matches the hub's default

async function resolveSigningKey(): Promise<{ pkcs8: string; kid: string; issuer: string; trusted: boolean }> {
  const envKey = process.env.AUTH_JWT_PRIVATE_KEY;
  if (envKey) {
    // A key the operator asserts the hub trusts (point it at the hub's real/preview keypair).
    return {
      pkcs8: envKey.replace(/\\n/g, '\n'),
      kid: process.env.AUTH_JWT_KID ?? 'e2e',
      issuer: process.env.AUTH_JWT_ISSUER ?? HUB_URL,
      trusted: true,
    };
  }
  // Ephemeral — structurally valid, NOT hub-trusted. Identity assertions will be skipped.
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  return {
    pkcs8: await exportPKCS8(privateKey),
    kid: 'e2e-ephemeral',
    issuer: HUB_URL,
    trusted: false,
  };
}

async function mintSessionToken(userId: number, key: { pkcs8: string; kid: string; issuer: string }) {
  const pk = await importPKCS8(key.pkcs8, 'ES256');
  return new SignJWT({ signedAt: Date.now() })
    .setProtectedHeader({ alg: 'ES256', kid: key.kid, typ: 'JWT' })
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_S)
    .setJti(uuid())
    .setIssuer(key.issuer)
    .sign(pk);
}

setup('mint hub sessions', async () => {
  if (!HUB_URL) throw new Error('HUB_URL is required to mint hub sessions');
  const key = await resolveSigningKey();

  // `__Secure-` prefix tracks the protocol exactly like the hub (https → __Secure-civ-token).
  const cookieName = sessionCookieName(HUB_URL.startsWith('https://'));
  const { hostname } = new URL(HUB_URL);

  fs.mkdirSync('e2e/.auth', { recursive: true });

  for (const role of Object.keys(HUB_USERS) as HubRole[]) {
    const token = await mintSessionToken(HUB_USERS[role].id, key);
    const storageState = {
      cookies: [
        {
          name: cookieName,
          value: token,
          domain: hostname,
          path: '/',
          expires: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_S,
          httpOnly: true,
          secure: HUB_URL.startsWith('https://'),
          sameSite: 'Lax' as const,
        },
      ],
      origins: [],
    };
    fs.writeFileSync(storageStatePath(role), JSON.stringify(storageState, null, 2));
  }

  const mode: MintMode = { trusted: key.trusted, kid: key.kid, issuer: key.issuer };
  fs.writeFileSync(mintModePath, JSON.stringify(mode, null, 2));
  // eslint-disable-next-line no-console
  console.log(
    `[hub-auth.setup] minted ${Object.keys(HUB_USERS).length} sessions as cookie "${cookieName}" ` +
      `(${key.trusted ? 'TRUSTED key — identity assertions WILL run' : 'EPHEMERAL key — identity assertions SKIPPED'})`
  );
});
