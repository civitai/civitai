import { hkdfSync } from 'node:crypto';
import { jwtDecrypt } from 'jose';
import type { SessionClaims } from './types';

// Decode the LEGACY next-auth v4 session cookie (`civitai-token`) WITHOUT any next-auth dependency. next-auth v4
// stores the session JWT as a JWE (`dir` key management, `A256GCM` content encryption) whose key is HKDF-derived
// from NEXTAUTH_SECRET. We only need to READ these during the cutover — until every user has the new ES256
// `civ-token` — so minting/refresh is gone; this is a ~15-line jose reimplementation of next-auth's decrypt.
// Returns null on any failure (corrupt / foreign / expired cookie); callers treat that as "no session".
//
// Drop this whole module once all legacy cookies have aged out (their max lifetime past the cutover).
const ENC_INFO = 'NextAuth.js Generated Encryption Key'; // next-auth v4's fixed HKDF `info`

function derivedKey(secret: string): Uint8Array {
  // next-auth v4: HKDF-SHA256(ikm=secret, salt='', info=ENC_INFO, length=32) → the A256GCM key.
  return new Uint8Array(hkdfSync('sha256', secret, '', ENC_INFO, 32));
}

export async function decodeLegacySessionCookie(
  token: string,
  secret: string
): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtDecrypt(token, derivedKey(secret), { clockTolerance: 15 });
    return payload as SessionClaims;
  } catch {
    return null;
  }
}
