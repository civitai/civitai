import { createHash, randomBytes } from 'crypto';
import { loadAuthEnv } from './env';

// SHARED key hashing for API keys + OAuth tokens. The hub and the main app must derive the SAME hash
// from the same key, so the salt comes from the PACKAGE env read of NEXTAUTH_SECRET (loadAuthEnv) rather
// than an app-specific schema. Server-only (node crypto) — not exported from ./client. The main app
// re-exports these from `~/server/utils/key-generator` so existing call sites are unchanged.

/** Generate a random public key (hex). Safe to send to the user. */
export function generateKey(length = 32): string {
  return randomBytes(length / 2).toString('hex');
}

/** SHA-512 hash of a public key salted with NEXTAUTH_SECRET. Stored in the DB. */
export function generateSecretHash(key: string): string {
  const secret = loadAuthEnv().NEXTAUTH_SECRET;
  // NEXTAUTH_SECRET is optional in the package env (the spoke verify-side may run without it post-
  // migration), but token hashing CANNOT proceed without it: an undefined salt would compute a
  // predictable `SHA512(key + "undefined")` AND wouldn't match the main app's hashes — silently breaking
  // token validation with no error. Fail fast for any token-hashing caller.
  if (!secret) {
    throw new Error('[@civitai/auth] NEXTAUTH_SECRET is required for generateSecretHash (token hashing)');
  }
  return createHash('sha512').update(`${key}${secret}`).digest('hex');
}
