// HUB sign side (Path C). The hub is the ONLY minter. This overrides next-auth's default
// symmetric JWT (JWE/hkdf) with an RS256-signed JWS, so spokes verify with the public key
// (see verify.ts) — no shared secret leaves the hub.
//
// Wire into next-auth options:
//   const signer = createSessionSigner();
//   const authOptions: NextAuthOptions = {
//     session: { strategy: 'jwt', maxAge: signer.maxAge },
//     jwt: { maxAge: signer.maxAge, encode: signer.encode, decode: signer.decode },
//     callbacks: { /* unchanged jwt()/session() — they shape `token.user` as today */ },
//   };
//
// The jwt()/session() CALLBACKS stay exactly as they are in next-auth-options.ts. Only the
// serialization (encode/decode) changes here — callbacks still build `token.user` via
// getSessionUser, refreshToken, etc. The encoder just signs whatever the callbacks produced.
import { randomUUID } from 'crypto';
import { importPKCS8, importSPKI, exportJWK, SignJWT } from 'jose';
import type { JWTEncodeParams, JWTDecodeParams, JWT } from 'next-auth/jwt';
import { loadAuthEnv } from './env';
import { createAuthVerifier } from './verify';

const ALG = 'RS256';

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
  encode: (params: JWTEncodeParams) => Promise<string>;
  decode: (params: JWTDecodeParams) => Promise<JWT | null>;
  /** Serve at GET /.well-known/jwks.json — public keys only. */
  publicJwks: () => Promise<{ keys: Record<string, unknown>[] }>;
  /**
   * Mint a short-lived, single-use SWAP transport token for the cross-root handoff
   * (replaces the AES civ-token). Signed with the same key → the receiving root verifies
   * it via JWKS with no shared secret. Served from /api/auth/sync.
   */
  mintSwapToken: (userId: number) => Promise<string>;
  /**
   * Framework-agnostic session minter: sign an RS256 session JWT from a claims object
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
    audience: config.audience ?? env.AUTH_JWT_AUDIENCE,
    maxAge: config.maxAge ?? env.AUTH_SESSION_MAX_AGE,
  };
  if (!cfg.privateKeyPem || !cfg.kid) {
    throw new Error('[@civitai/auth] hub signer requires AUTH_JWT_PRIVATE_KEY and AUTH_JWT_KID');
  }

  // PEM-in-env normalization: accept either a real multiline PEM (e.g. a k8s secret or a quoted
  // .env value) or a single-line value with literal `\n` escapes (what many secret stores / env
  // UIs emit). jose needs real newlines, so convert escaped `\n` back.
  const normalizePem = (pem: string) => pem.replace(/\\n/g, '\n');

  // Imported once, lazily — importing this module never touches process.env.
  let _priv: ReturnType<typeof importPKCS8> | undefined;
  const privateKey = () => (_priv ??= importPKCS8(normalizePem(cfg.privateKeyPem!), ALG));

  // Decode reuses the spoke verifier so the hub accepts both new RS256 and (during the
  // migration window) legacy tokens it previously issued. Built lazily so a mint-only hub
  // (e.g. the SvelteKit login app) never needs verify config.
  let _verifier: ReturnType<typeof createAuthVerifier> | undefined;
  const getVerifier = () => (_verifier ??= createAuthVerifier());

  // Framework-agnostic session minter — sign an RS256 session JWT from a claims object.
  // The SvelteKit hub calls this directly after login; next-auth's `encode` wraps it.
  async function mintSessionToken(
    payload: Record<string, unknown>,
    opts?: { expiresIn?: number; jti?: string }
  ): Promise<string> {
    const ttl = opts?.expiresIn ?? cfg.maxAge;
    // Strip reserved claims the setters own; keep everything else (notably `user`,
    // `id`, `signedAt`).
    const { iat, exp, nbf, jti, iss, aud, ...rest } = payload as Record<string, unknown>;
    return new SignJWT(rest)
      .setProtectedHeader({ alg: ALG, kid: cfg.kid, typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
      .setJti(String(opts?.jti ?? (jti as string | undefined) ?? randomUUID()))
      .setIssuer(cfg.issuer ?? '')
      .setAudience(cfg.audience ?? '')
      .sign(await privateKey());
  }

  async function encode({ token, maxAge }: JWTEncodeParams): Promise<string> {
    return mintSessionToken((token ?? {}) as Record<string, unknown>, {
      expiresIn: maxAge ?? cfg.maxAge,
      jti: (token as JWT)?.id as string | undefined,
    });
  }

  async function decode({ token }: JWTDecodeParams): Promise<JWT | null> {
    if (!token) return null;
    return (await getVerifier().verifyToken(token)) as JWT | null;
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
    return new SignJWT({ purpose: 'swap' })
      .setProtectedHeader({ alg: ALG, kid: cfg.kid, typ: 'JWT' })
      .setSubject(String(userId))
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + (env.AUTH_SWAP_MAX_AGE ?? 60))
      .setJti(randomUUID())
      .setIssuer(cfg.issuer ?? '')
      .setAudience(cfg.audience ?? '')
      .sign(await privateKey());
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
    encode,
    decode,
    publicJwks,
    mintSwapToken,
    mintSessionToken,
    mintIdToken,
  };
}

/**
 * Opt-in constructor: returns a signer only when the RS256 keys are configured, else
 * undefined. Lets the hub wire `jwt.encode/decode` without breaking when the keys aren't
 * set yet (Path A / pre-cutover) — behavior falls back to next-auth's default JWE.
 */
export function maybeCreateSessionSigner(
  config: SessionSignerConfig = {}
): SessionSigner | undefined {
  const env = loadAuthEnv();
  const hasKeys =
    (config.privateKeyPem ?? env.AUTH_JWT_PRIVATE_KEY) && (config.kid ?? env.AUTH_JWT_KID);
  return hasKeys ? createSessionSigner(config) : undefined;
}
