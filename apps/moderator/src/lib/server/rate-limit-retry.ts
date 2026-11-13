import type { ActionResult } from './user-actions.service';

/**
 * `send`, sent again after each rate-limit refusal's `Retry-After` until it answers or `deadline`
 * (epoch ms) would pass. Safe only because a 429 is refused before the endpoint acts, so a resend
 * cannot apply the write twice; every other failure is returned as it came.
 */
export async function retryRateLimited(
  send: () => Promise<ActionResult>,
  deadline: number
): Promise<ActionResult> {
  for (;;) {
    const result = await send();
    if (result.ok) return result;
    const waitMs = (result.retryAfterSeconds ?? 0) * 1000;
    if (!waitMs || Date.now() + waitMs > deadline) return result;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}
