import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { env } from '~/env/server';

const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/**
 * Catches an absent or placeholder secret, not weak ones — `NEXTAUTH_SECRET` is
 * `z.string()` with no `.min()`, so nothing upstream enforces a length.
 */
const MIN_SECRET_LENGTH = 8;

/**
 * A key of its own per `domain`, so a token sealed for one purpose never opens
 * under another keyed by the same secret.
 */
function sealKey(domain: string): Buffer | null {
  // With an empty secret the key would be sha256(':<domain>'), a constant anyone
  // can compute from source. Fail closed rather than mint forgeable tokens.
  const secret = env.NEXTAUTH_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) return null;
  return createHash('sha256').update(`${secret}:${domain}`).digest();
}

type SealOptions = {
  /** Key-derivation domain, e.g. `remix-provenance:v1`. */
  domain: string;
  /** Wire prefix, the first dot-separated segment. */
  prefix: string;
  /** Bound into the tag but not carried: a token opens only with the same value. */
  aad?: string;
};

/**
 * AES-256-GCM: encrypted and authenticated, so the payload is opaque to whoever
 * holds the token. Wire form `<prefix>.<iv>.<ciphertext>.<tag>`, base64url.
 * Undefined when no usable secret is configured.
 */
export function sealToken(payload: unknown, { domain, prefix, aad }: SealOptions) {
  const key = sealKey(domain);
  if (!key) return undefined;

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);

  return [
    prefix,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

/** The decrypted payload, or null for anything that does not open. Never throws. */
export function openToken(token: unknown, { domain, prefix, aad }: SealOptions): unknown {
  if (typeof token !== 'string') return null;

  const [tokenPrefix, iv, ciphertext, tag, extra] = token.split('.');
  if (tokenPrefix !== prefix || !iv || !ciphertext || !tag || extra !== undefined) return null;

  const ivBytes = Buffer.from(iv, 'base64url');
  const tagBytes = Buffer.from(tag, 'base64url');
  // 🔴 Node accepts GCM tags of 4, 8, 12–16 bytes and verifies against only what
  // it is given, so a caller who truncates the tag downgrades a 128-bit forgery
  // to a 32-bit one. Measured: a valid token with its tag cut to 4 bytes
  // decrypts and verifies. Full length or nothing.
  if (ivBytes.length !== IV_BYTES || tagBytes.length !== AUTH_TAG_BYTES) return null;

  const key = sealKey(domain);
  if (!key) return null;

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, ivBytes);
    decipher.setAuthTag(tagBytes);
    if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}
