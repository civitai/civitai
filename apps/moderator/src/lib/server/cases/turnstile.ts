import { env } from '$env/dynamic/private';
import { civitaiAppUrl } from '../civitai-url';

export const TURNSTILE_ACTION = 'takedown-intake';
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Refused before anything is written: the challenge failed or was already used. */
export class TurnstileRefusedError extends Error {
  readonly status = 400;
  readonly public = true;
  constructor() {
    super('The challenge could not be verified. Reload the page and try again.');
    this.name = 'TurnstileRefusedError';
  }
}

/** The sites the forms are served from: TURNSTILE_HOSTNAMES (comma-separated), else the main app's host. */
const formHostnames = () =>
  (env.TURNSTILE_HOSTNAMES || new URL(civitaiAppUrl()).hostname)
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

/**
 * Its own siteverify call rather than main's `verifyCaptchaToken`: that one lives in the Next app,
 * with its own env and logging, and this app cannot import it. A shared package for both is the place
 * to merge them.
 *
 * Verifies a Turnstile token, once: a token passes siteverify a single time, which is why the main app
 * forwards it here instead of checking it itself. Fails closed: no secret, no answer, or an answer that
 * is not a success all refuse the request.
 */
export async function verifyTurnstile(
  token: string,
  ip: string,
  {
    secret = env.TURNSTILE_SECRET,
    fetcher = fetch,
    hostnames = formHostnames(),
  }: { secret?: string; fetcher?: typeof fetch; hostnames?: string[] } = {}
) {
  if (!secret) throw Object.assign(new Error('Turnstile is not configured'), { status: 503 });
  let res: Response;
  try {
    res = await fetcher(SITEVERIFY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(4_000),
    });
  } catch {
    throw Object.assign(new Error('No response from the challenge service'), { status: 502 });
  }
  if (!res.ok)
    throw Object.assign(new Error('No response from the challenge service'), { status: 502 });
  const body = (await res.json().catch(() => null)) as {
    success?: unknown;
    action?: unknown;
    hostname?: unknown;
  } | null;
  // The form's widget sets this action and is served from these hosts, so a token solved on another
  // page or site with the same key fails.
  if (
    body?.success !== true ||
    body.action !== TURNSTILE_ACTION ||
    typeof body.hostname !== 'string' ||
    !hostnames.includes(body.hostname.toLowerCase())
  )
    throw new TurnstileRefusedError();
}
