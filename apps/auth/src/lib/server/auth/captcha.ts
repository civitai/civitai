import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';

// Cloudflare Turnstile verification, mirroring the main app's verifyCaptchaToken (recaptcha/client.ts).
// Uses the managed widget — the same one the main app's email sign-in uses:
//   CF_MANAGED_TURNSTILE_SECRET (server-side verify) + CF_MANAGED_TURNSTILE_SITEKEY (widget).
// (The hub reads the sitekey server-side and hands it to the page via SSR, so unlike the main app
// it doesn't need a NEXT_PUBLIC_ prefix.)

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Enforced only when the secret is set AND not in dev (mirrors the main app's dev bypass). When
 *  disabled, verifyCaptchaToken passes through so local/un-configured envs aren't blocked. */
export function isCaptchaEnabled(): boolean {
  return !dev && !!env.CF_MANAGED_TURNSTILE_SECRET;
}

/** Public site key for the widget — server-read and handed to the page via load data (it's public
 *  by design; this just avoids a PUBLIC_ env var). Undefined → the page renders no widget. */
export function captchaSiteKey(): string | undefined {
  return env.CF_MANAGED_TURNSTILE_SITEKEY || undefined;
}

/** Verify a Turnstile token with Cloudflare. Returns true when captcha is disabled; false on a
 *  missing/invalid token or any verification error (fail-closed when enabled). */
export async function verifyCaptchaToken(token: string | undefined, ip?: string): Promise<boolean> {
  if (!isCaptchaEnabled()) return true;
  if (!token) return false;
  try {
    const res = await fetch(SITEVERIFY, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: env.CF_MANAGED_TURNSTILE_SECRET, response: token, remoteip: ip }),
    });
    if (!res.ok) return false;
    const outcome = (await res.json()) as { success?: boolean };
    return !!outcome.success;
  } catch {
    return false;
  }
}
