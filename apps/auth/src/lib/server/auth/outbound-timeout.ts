import { env } from '$env/dynamic/private';

/**
 * The abort signal for one outbound call made inside a sign-in request (Turnstile siteverify, the OAuth
 * provider calls), so a hung upstream fails the sign-in instead of holding it for undici's 300 s header
 * timeout. `AUTH_OUTBOUND_TIMEOUTS=off` sends without one (the behaviour before these bounds).
 */
export function outboundTimeoutSignal(ms: number): AbortSignal | undefined {
  return env.AUTH_OUTBOUND_TIMEOUTS === 'off' ? undefined : AbortSignal.timeout(ms);
}
