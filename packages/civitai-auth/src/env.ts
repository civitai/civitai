// Package-owned env schema for @civitai/auth. Lazy + memoized — importing this
// module never touches process.env (see base-package-rules: env loads lazily so a
// bare import during `next build` / scripts / tests never throws).
//
// Two roles read different slices:
//  - SPOKE (verify):  AUTH_JWKS_URI, AUTH_JWT_ISSUER, and during the
//                     HS256->RS256 migration window NEXTAUTH_SECRET (legacy decode).
//  - HUB   (sign):    AUTH_JWT_PRIVATE_KEY (PKCS8 PEM), AUTH_JWT_PUBLIC_KEY (SPKI PEM,
//                     served at the JWKS endpoint), AUTH_JWT_KID, AUTH_SESSION_MAX_AGE.
import * as z from 'zod';

const schema = z.object({
  // --- spoke: verify side ---
  AUTH_JWKS_URI: z.url().optional(), // e.g. https://auth.civitai.com/.well-known/jwks.json
  AUTH_JWT_ISSUER: z.string().optional(), // e.g. https://auth.civitai.com
  // SERVER-ONLY internal-routing override for the session-identity read (session-client.ts fetchIdentity).
  // When set, the identity fetch is sent to THIS base (the in-cluster hub svc, e.g.
  // http://civitai-auth.civitai-auth.svc.cluster.local:3000) instead of hairpinning out to the public
  // AUTH_JWT_ISSUER origin (CF edge → Traefik → back to the same cluster). It ONLY changes the FETCH target —
  // the token's `iss` is STILL validated against the public trusted origin(s) first (trustedHubBase), so the
  // override can never be used to send a bearer to an untrusted issuer. Deliberately NOT a `NEXT_PUBLIC_*`
  // var: it is read on the server only and must never reach the client bundle.
  AUTH_HUB_INTERNAL_URL: z.url().optional(), // e.g. http://civitai-auth.civitai-auth.svc.cluster.local:3000
  // Legacy symmetric secret — kept ONLY for the migration window so spokes can still
  // decode pre-cutover next-auth JWE cookies. Drop after the max old-token TTL.
  NEXTAUTH_SECRET: z.string().optional(),
  // Shared service secret for trusted server-to-server calls — the session-invalidator presents it to the
  // hub's `POST /api/auth/identity` (cache bust/refresh). Set on the hub AND any app that invalidates.
  AUTH_INTERNAL_TOKEN: z.string().optional(),

  // --- hub: sign side (all optional; only the hub sets them) ---
  AUTH_JWT_PRIVATE_KEY: z.string().optional(), // PKCS8 PEM (or a KMS handle — see open questions)
  AUTH_JWT_PUBLIC_KEY: z.string().optional(), // SPKI PEM, exported as a JWK at the endpoint
  AUTH_JWT_KID: z.string().optional(),
  AUTH_SESSION_MAX_AGE: z.coerce.number().default(30 * 24 * 60 * 60), // 30d, matches today
});

function buildEnv() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      '[@civitai/auth] Invalid environment variables:\n' + z.prettifyError(parsed.error)
    );
  }
  return parsed.data;
}

export type AuthEnv = ReturnType<typeof buildEnv>;

let _env: AuthEnv | undefined;
export function loadAuthEnv(): AuthEnv {
  return (_env ??= buildEnv());
}
