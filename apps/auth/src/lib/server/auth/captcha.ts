import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { captchaVerificationsTotal } from '$lib/server/metrics';
import { logToAxiom } from '$lib/server/axiom';

// Fire-and-forget Axiom line for a captcha rejection, so the failure BREAKDOWN (which reason dominates) is
// queryable outside the cluster: `['civitai-prod'] | where name == 'captcha-reject' | summarize count() by
// reason`. A `no_token` majority confirms the client submits with no token (invisible widget failed for the
// user) rather than a config/hostname problem (ClickUp 868k9gug8). Never logs the token or secret.
const logRejectAxiom = (fields: Record<string, unknown>) =>
  logToAxiom({ name: 'captcha-reject', ...fields }).catch(() => undefined);

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

// Cloudflare's official TEST keys — they render/verify REAL Turnstile widgets on any host incl. localhost, so
// the whole captcha flow (and the interactive fallback) is exercisable in dev. Gated behind CAPTCHA_DEV so a
// normal dev server stays captcha-free. https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const TEST_INVISIBLE_SITEKEY = '1x00000000000000000000BB'; // always passes, invisible
const TEST_MANAGED_SITEKEY = '3x00000000000000000000FF'; // forces an interactive challenge (visible)
const TEST_SECRET_PASS = '1x0000000000000000000000000000000AA'; // always passes

export type CaptchaMode = 'invisible' | 'managed';

/** Dev-only opt-in: run real captcha locally with the CF test keys above. Off unless CAPTCHA_DEV=true. */
function devCaptcha(): boolean {
  return dev && env.CAPTCHA_DEV === 'true';
}

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

/** On in prod when the invisible secret is set; in dev only when CAPTCHA_DEV opts into the CF test keys. When
 *  disabled, verifyCaptchaToken passes through so local/un-configured envs aren't blocked. */
export function isCaptchaEnabled(): boolean {
  if (dev) return devCaptcha();
  return !!env.CF_INVISIBLE_TURNSTILE_SECRET;
}

/** Invisible widget sitekey (the ~99% background path) — server-read and handed to the page via load data
 *  (public by design; avoids a PUBLIC_ env var). Undefined → no widget. Uses the CF test key under CAPTCHA_DEV. */
export function captchaSiteKey(): string | undefined {
  return env.CF_INVISIBLE_TURNSTILE_SITEKEY || (devCaptcha() ? TEST_INVISIBLE_SITEKEY : undefined);
}

/** Managed (interactive) widget sitekey — the fallback the client renders ONLY after the invisible widget
 *  fails. Undefined when unprovisioned, so the client never renders the fallback (behavior == pre-fallback).
 *  Uses the CF forced-challenge test key under CAPTCHA_DEV. */
export function captchaManagedSiteKey(): string | undefined {
  return env.CF_MANAGED_TURNSTILE_SITEKEY || (devCaptcha() ? TEST_MANAGED_SITEKEY : undefined);
}

/** The verify secret for a given widget mode, with the CF dummy-pass secret as the dev default. */
function secretFor(mode: CaptchaMode): string | undefined {
  const real = mode === 'managed' ? env.CF_MANAGED_TURNSTILE_SECRET : env.CF_INVISIBLE_TURNSTILE_SECRET;
  return real || (devCaptcha() ? TEST_SECRET_PASS : undefined);
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
export async function verifyCaptchaToken(
  token: string | undefined,
  ip?: string,
  opts: { mode?: CaptchaMode; failReason?: string } = {}
): Promise<boolean> {
  const mode = opts.mode ?? 'invisible';
  // Pass-through when captcha is disabled — NOT counted (no verification actually happened).
  if (!isCaptchaEnabled()) return true;
  if (!token) {
    captchaVerificationsTotal.inc({ result: 'no_token' });
    // failReason (client-supplied) splits no_token into widget-error / timeout / fallback-error, so we can size
    // the RECOVERABLE (invisible-declined → the interactive fallback helps) vs UNRECOVERABLE (Turnstile fully
    // blocked) populations: `['civitai-prod'] | where name=='captcha-reject' | summarize count() by failReason`.
    logRejectAxiom({ reason: 'no_token', mode, failReason: opts.failReason, ip });
    return false;
  }
  const secret = secretFor(mode);
  if (!secret) {
    // mode=managed but no managed secret configured — the client shouldn't have rendered the managed widget.
    captchaVerificationsTotal.inc({ result: 'no_secret' });
    logRejectAxiom({ reason: 'no-secret', mode, ip });
    return false;
  }
  try {
    const res = await fetch(SITEVERIFY, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret, response: token, remoteip: ip }),
    });
    if (!res.ok) {
      console.error('captcha verify rejected', { reason: 'siteverify-http', status: res.status });
      captchaVerificationsTotal.inc({ result: 'http_error' });
      logRejectAxiom({ reason: 'http_error', status: res.status, ip });
      return false;
    }
    const outcome = (await res.json()) as {
      success?: boolean;
      hostname?: string;
      action?: string;
      'error-codes'?: string[];
    };

    const logReject = (reason: string) => {
      console.error('captcha verify rejected', {
        reason,
        success: !!outcome.success,
        hostname: outcome.hostname,
        action: outcome.action,
        'error-codes': outcome['error-codes'],
      });
      // Mirror the reject reason to the counter (dash→underscore for a valid label value:
      // siteverify-failed→siteverify_failed, hostname-mismatch→hostname_mismatch, …).
      captchaVerificationsTotal.inc({ result: reason.replace(/-/g, '_') });
      logRejectAxiom({
        reason,
        mode,
        hostname: outcome.hostname,
        action: outcome.action,
        errorCodes: outcome['error-codes'],
        ip,
      });
    };

    if (!outcome.success) {
      logReject('siteverify-failed');
      return false;
    }

    // Pin the token to this property — a token solved on the shared-secret main app must not log in here.
    // Skipped in dev: the CF test tokens don't solve on the hub host, and dev has nothing to replay-protect.
    const wantHost = dev ? undefined : expectedHostname();
    if (wantHost && outcome.hostname !== wantHost) {
      logReject('hostname-mismatch');
      return false;
    }

    // Pin the token to the login flow — but TOLERATE an empty/absent action. The hostname check
    // above already closes the cross-property replay gap, and auth.civitai.com hosts only the login
    // widget, so an action-less token solved on our host (e.g. a tab loaded before data-action="login"
    // shipped) is still a real human on our domain. Only reject a token explicitly stamped with a
    // DIFFERENT action. (Strict `!== EXPECTED_ACTION` blocked stale pre-deploy tabs in a retry loop.)
    if (outcome.action && outcome.action !== EXPECTED_ACTION) {
      logReject('action-mismatch');
      return false;
    }

    captchaVerificationsTotal.inc({ result: 'success' });
    return true;
  } catch {
    return false;
  }
}
