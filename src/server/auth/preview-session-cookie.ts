import { hkdfSync } from 'node:crypto';
import { jwtDecrypt } from 'jose';
import type { SessionClaims } from '@civitai/auth';

// PR previews only. The preview pipeline signs its smoke users in with a next-auth v4 style cookie (a `dir` /
// `A256GCM` JWE keyed by HKDF from NEXTAUTH_SECRET; see tests/preview-auth.setup.ts). Only a preview on a scratch
// database reads this format: IS_PREVIEW === 'true' AND DATABASE_ENVIRONMENT === 'non-production', both set
// explicitly. Anything else returns null before decrypting.
const ENC_INFO = 'NextAuth.js Generated Encryption Key';

export const previewCookieSignInEnabled = (): boolean =>
  process.env.IS_PREVIEW === 'true' && process.env.DATABASE_ENVIRONMENT === 'non-production';

export async function decodePreviewSessionCookie(
  token: string,
  secret: string
): Promise<SessionClaims | null> {
  if (!previewCookieSignInEnabled()) return null;
  try {
    const key = new Uint8Array(hkdfSync('sha256', secret, '', ENC_INFO, 32));
    const { payload } = await jwtDecrypt(token, key, { clockTolerance: 15 });
    if (payload.exp == null) return null;
    if ('impersonatedBy' in payload || 'impExp' in payload) return null;
    return payload as SessionClaims;
  } catch {
    return null;
  }
}
