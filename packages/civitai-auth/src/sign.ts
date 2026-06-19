// HUB sign side (Path C). The hub is the ONLY minter. ES256-signed JWS, so spokes verify with
// the public key (see verify.ts) — no shared secret leaves the hub.
//
// The hub (apps/auth, SvelteKit) mints the session cookie directly via `mintSessionToken` after
// login. `mintSwapToken` / `mintIdToken` cover the cross-root handoff and OIDC id_token.
import { randomUUID } from 'crypto';
import { importPKCS8, importSPKI, exportJWK, SignJWT, type CryptoKey } from 'jose';
import { loadAuthEnv } from './env';

// ES256 (ECDSA P-256): asymmetric + JWKS-publishable like RS256, but ~64-byte signatures (vs RS256's
// 256), so the session cookie + OIDC id_tokens are much smaller — and still broadly supported by OIDC
// relying parties. The same hub key signs both, so EC P-256 keys are required (AUTH_JWT_PRIVATE_KEY /
// AUTH_JWT_PUBLIC_KEY must be an EC keypair).
const ALG = 'ES256';

// Boot-time guard: ES256 demands an EC P-256 (prime256v1) private key. An RSA/Ed25519/etc. key is a
// config error (out-of-date keygen docs are the classic cause) — without this, jose surfaces it as a
// cryptic "Invalid key type" (or, on a jose version that imports it leniently, only at sign time).
// We turn both cases into one actionable message naming the env var and the required key type. Works
// on the WebCrypto CryptoKey jose returns: key.algorithm is { name: 'ECDSA', namedCurve: 'P-256' }.
async function assertEcP256(imported: Promise<CryptoKey>): Promise<CryptoKey> {
  let key: CryptoKey;
  try {
    key = await imported;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[@civitai/auth] AUTH_JWT_PRIVATE_KEY must be an EC P-256 (prime256v1) key for ES256; ` +
        `it failed to import as one (${reason}). Generate with: ` +
        `openssl ecparam -genkey -name prime256v1 -noout -out priv.pem`
    );
  }
  const alg = key.algorithm as { name?: string; namedCurve?: string };
  if (alg?.name !== 'ECDSA' || alg?.namedCurve !== 'P-256') {
    throw new Error(
      `[@civitai/auth] AUTH_JWT_PRIVATE_KEY must be an EC P-256 (prime256v1) key for ES256; ` +
        `got ${alg?.name ?? 'unknown'}${alg?.namedCurve ? ` (${alg.namedCurve})` : ''}. ` +
        `Generate with: openssl ecparam -genkey -name prime256v1 -noout -out priv.pem`
    );
  }
  return key;
}

export interface SessionSignerConfig {
  privateKeyPem?: string; // PKCS8
  publicKeyPem?: string; // SPKI — for the JWKS endpoint
  kid?: string;
  issuer?: string;
  audience?: string;
  maxAge?: number; // seconds
}

export interface SessionSigner {
  maxAge: number;
  /** Serve at GET /.well-known/jwks.json — public keys only. */
  publicJwks: () => Promise<{ keys: Record<string, unknown>[] }>;
  /**
   * Mint a short-lived, single-use SWAP transport token for the cross-root handoff
   * (replaces the AES civ-token). Signed with the same key → the receiving root verifies
   * it via JWKS with no shared secret. Served from /api/auth/sync.
   */
  mintSwapToken: (userId: number) => Promise<string>;
  /**
   * Framework-agnostic session minter: sign an ES256 session JWT from a claims object
   * (e.g. `{ user, id, signedAt }`). Used by non-next-auth hubs (the SvelteKit login app)
   * to issue the session cookie directly; `encode` is a next-auth-shaped wrapper around it.
   */
  mintSessionToken: (
    payload: Record<string, unknown>,
    opts?: { expiresIn?: number; jti?: string }
  ) => Promise<string>;
  /**
   * Mint an OIDC `id_token` for a third-party OAuth client ("Sign in with Civitai").
   * Signed with the same hub key → the relying party verifies it via the public JWKS using
   * any standard OIDC library. `aud` is the client_id; `nonce` (from the auth request) must
   * be echoed for replay protection. Profile/email claims are optional (the RP can also call
   * /userinfo) — pass them via `claims`, gated by the granted scope.
   */
  mintIdToken: (params: {
    sub: string | number;
    aud: string;
    nonce?: string;
    authTime?: number; // epoch seconds
    claims?: Record<string, unknown>;
    expiresIn?: number; // seconds, default 3600
  }) => Promise<string>;
}

export function createSessionSigner(config: SessionSignerConfig = {}): SessionSigner {
  const env = loadAuthEnv();
  const cfg = {
    privateKeyPem: config.privateKeyPem ?? env.AUTH_JWT_PRIVATE_KEY,
    publicKeyPem: config.publicKeyPem ?? env.AUTH_JWT_PUBLIC_KEY,
    kid: config.kid ?? env.AUTH_JWT_KID,
    issuer: config.issuer ?? env.AUTH_JWT_ISSUER,
    audience: config.audience,
    maxAge: config.maxAge ?? env.AUTH_SESSION_MAX_AGE,
  };
  if (!cfg.privateKeyPem || !cfg.kid) {
    throw new Error('[@civitai/auth] hub signer requires AUTH_JWT_PRIVATE_KEY and AUTH_JWT_KID');
  }

  // PEM-in-env normalization: accept either a real multiline PEM (e.g. a k8s secret or a quoted
  // .env value) or a single-line value with literal `\n` escapes (what many secret stores / env
  // UIs emit). jose needs real newlines, so convert escaped `\n` back.
  const normalizePem = (pem: string) => pem.replace(/\\n/g, '\n');

  // Imported once, lazily — importing this module never touches process.env. The import is wrapped
  // by assertEcP256 so a misconfigured key (e.g. an RSA key from out-of-date keygen docs) fails fast
  // with an actionable message instead of jose's cryptic "Invalid key type".
  let _priv: Promise<CryptoKey> | undefined;
  const privateKey = () =>
    (_priv ??= assertEcP256(importPKCS8(normalizePem(cfg.privateKeyPem!), ALG)));

  // Framework-agnostic session minter — sign an ES256 session JWT from a claims object.
  // The SvelteKit hub calls this directly after login.
  async function mintSessionToken(
    payload: Record<string, unknown>,
    opts?: { expiresIn?: number; jti?: string }
  ): Promise<string> {
    const ttl = opts?.expiresIn ?? cfg.maxAge;
    // Strip reserved claims the setters own; keep everything else (notably `user`,
    // `id`, `signedAt`).
    const { iat, exp, nbf, jti, iss, aud, ...rest } = payload as Record<string, unknown>;
    const builder = new SignJWT(rest)
      .setProtectedHeader({ alg: ALG, kid: cfg.kid, typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
      .setJti(String(opts?.jti ?? (jti as string | undefined) ?? randomUUID()))
      .setIssuer(cfg.issuer ?? '');
    if (cfg.audience) builder.setAudience(cfg.audience); // omit an empty `aud` to keep the token small
    return builder.sign(await privateKey());
  }

  async function publicJwks() {
    if (!cfg.publicKeyPem) {
      throw new Error('[@civitai/auth] publicJwks requires AUTH_JWT_PUBLIC_KEY (SPKI PEM)');
    }
    const pub = await importSPKI(normalizePem(cfg.publicKeyPem), ALG);
    const jwk = await exportJWK(pub);
    return { keys: [{ ...jwk, kid: cfg.kid, use: 'sig', alg: ALG }] };
  }

  async function mintSwapToken(userId: number): Promise<string> {
    const builder = new SignJWT({ purpose: 'swap' })
      .setProtectedHeader({ alg: ALG, kid: cfg.kid, typ: 'JWT' })
      .setSubject(String(userId))
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + (env.AUTH_SWAP_MAX_AGE ?? 60))
      .setJti(randomUUID())
      .setIssuer(cfg.issuer ?? '');
    if (cfg.audience) builder.setAudience(cfg.audience);
    return builder.sign(await privateKey());
  }

  async function mintIdToken(params: {
    sub: string | number;
    aud: string;
    nonce?: string;
    authTime?: number;
    claims?: Record<string, unknown>;
    expiresIn?: number;
  }): Promise<string> {
    const ttl = params.expiresIn ?? 3600; // 1h, typical id_token lifetime
    // OIDC requires `iss` to equal the discovery `issuer` (NEXTAUTH_URL) — set AUTH_JWT_ISSUER
    // to that value. `aud` is the client_id, `nonce` is echoed for replay protection.
    return new SignJWT({
      ...(params.claims ?? {}),
      ...(params.nonce ? { nonce: params.nonce } : {}),
      ...(params.authTime ? { auth_time: params.authTime } : {}),
    })
      .setProtectedHeader({ alg: ALG, kid: cfg.kid, typ: 'JWT' })
      .setSubject(String(params.sub))
      .setAudience(params.aud)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
      .setIssuer(cfg.issuer ?? '')
      .sign(await privateKey());
  }

  return {
    maxAge: cfg.maxAge,
    publicJwks,
    mintSwapToken,
    mintSessionToken,
    mintIdToken,
  };
}

/**
 * Opt-in constructor: returns a signer only when the ES256 keys are configured, else
 * undefined. Lets callers (e.g. the optional OIDC id_token signer in the main app) wire the
 * signer without breaking when the keys aren't set yet.
 */
export function maybeCreateSessionSigner(
  config: SessionSignerConfig = {}
): SessionSigner | undefined {
  const env = loadAuthEnv();
  const hasKeys =
    (config.privateKeyPem ?? env.AUTH_JWT_PRIVATE_KEY) && (config.kid ?? env.AUTH_JWT_KID);
  return hasKeys ? createSessionSigner(config) : undefined;
}
