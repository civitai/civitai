import { env } from '$env/dynamic/private';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Refused before anything is written: the challenge failed or was already used. */
export class TurnstileRefusedError extends Error {
  readonly status = 400;
  constructor() {
    super('The challenge could not be verified. Reload the page and try again.');
    this.name = 'TurnstileRefusedError';
  }
}

/**
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
  }: { secret?: string; fetcher?: typeof fetch } = {}
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
  const body = (await res.json().catch(() => null)) as { success?: unknown } | null;
  if (body?.success !== true) throw new TurnstileRefusedError();
}
