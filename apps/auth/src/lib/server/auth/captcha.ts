import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';

// Cloudflare Turnstile verification, mirroring the main app's verifyCaptchaToken (recaptcha/client.ts).
// Uses the INVISIBLE widget (CF dashboard widget-mode = Invisible):
//   CF_INVISIBLE_TURNSTILE_SECRET (server-side verify) + CF_INVISIBLE_TURNSTILE_SITEKEY (widget).
// This is the same frictionless key the main app's high-volume flows use (~99% solve). The hub
// originally used the *managed* key, which renders an interactive challenge that only ~50% of users
// completed — breaking email login. The invisible widget runs in the background and auto-solves.
// (The hub reads the sitekey server-side and hands it to the page via SSR, so unlike the main app
// it doesn't need a NEXT_PUBLIC_ prefix.)

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// The action the login widget tags its token with (data-action="login" on the .cf-turnstile div).
// Client + server ship in the same image, so every real token carries this.
const EXPECTED_ACTION = 'login';

/** The hub's own hostname, derived from ORIGIN (e.g. https://auth.civitai.com → auth.civitai.com).
 *  Used to reject tokens solved on a DIFFERENT property that shares this sitekey+secret (the main
 *  civitai.com app uses the identical invisible key) — a narrow cross-property token replay. When
 *  ORIGIN is unset/unparseable we return undefined and SKIP the hostname check (don't break login). */
function expectedHostname(): string | undefined {
  const origin = env.ORIGIN;
  if (!origin) return undefined;
  try {
    return new URL(origin).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** Enforced only when the secret is set AND not in dev (mirrors the main app's dev bypass). When
 *  disabled, verifyCaptchaToken passes through so local/un-configured envs aren't blocked. */
export function isCaptchaEnabled(): boolean {
  return !dev && !!env.CF_INVISIBLE_TURNSTILE_SECRET;
}

/** Public site key for the widget — server-read and handed to the page via load data (it's public
 *  by design; this just avoids a PUBLIC_ env var). Undefined → the page renders no widget. */
export function captchaSiteKey(): string | undefined {
  return env.CF_INVISIBLE_TURNSTILE_SITEKEY || undefined;
}

/** Verify a Turnstile token with Cloudflare. Returns true when captcha is disabled; false on a
 *  missing/invalid token or any verification error (fail-closed when enabled).
 *
 *  Beyond `outcome.success` we also pin the token to THIS property and THIS flow per CF best practice
 *  (https://developers.cloudflare.com/turnstile/get-started/server-side-validation/):
 *   - hostname must equal the hub's own host (closes the shared-sitekey cross-property replay gap;
 *     skipped only when ORIGIN is unset/unparseable), and
 *   - action must equal "login" (the value the login widget tags its token with).
 *  Any rejection logs one structured line incl. CF's error-codes (never the token/secret). */
export async function verifyCaptchaToken(token: string | undefined, ip?: string): Promise<boolean> {
  if (!isCaptchaEnabled()) return true;
  if (!token) return false;
  try {
    const res = await fetch(SITEVERIFY, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: env.CF_INVISIBLE_TURNSTILE_SECRET, response: token, remoteip: ip }),
    });
    if (!res.ok) {
      console.error('captcha verify rejected', { reason: 'siteverify-http', status: res.status });
      return false;
    }
    const outcome = (await res.json()) as {
      success?: boolean;
      hostname?: string;
      action?: string;
      'error-codes'?: string[];
    };

    const logReject = (reason: string) =>
      console.error('captcha verify rejected', {
        reason,
        success: !!outcome.success,
        hostname: outcome.hostname,
        action: outcome.action,
        'error-codes': outcome['error-codes'],
      });

    if (!outcome.success) {
      logReject('siteverify-failed');
      return false;
    }

    // Pin the token to this property — a token solved on the shared-secret main app must not log in here.
    const wantHost = expectedHostname();
    if (wantHost && outcome.hostname !== wantHost) {
      logReject('hostname-mismatch');
      return false;
    }

    // Pin the token to the login flow.
    if (outcome.action !== EXPECTED_ACTION) {
      logReject('action-mismatch');
      return false;
    }

    return true;
  } catch {
    return false;
  }
}
