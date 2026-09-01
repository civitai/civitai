import { env } from '~/env/server';

/**
 * Post a title/description alert to the moderator Discord channel.
 *
 * Extracted from the two health-check jobs, which had byte-identical copies. The reason to share it
 * is not the ten lines: the fleet already disagrees about whether a hung webhook can stall its
 * caller — `apps-shared.router.ts` passes `AbortSignal.timeout(5_000)` and the health checks pass
 * nothing, while a job holds its lock for the duration. Whoever settles that should have one place
 * to change, not five.
 *
 * Behaviour is deliberately unchanged from the copies this replaces, timeout included. Only the
 * return value is new.
 *
 * The richer field-based embeds elsewhere (`git-push.ts`, `new-order-jobs.ts`,
 * `publish-request.service.ts`) are a different shape and are not served by this.
 *
 * @returns whether the alert actually landed. A caller that reports "paged" off its own intent
 * rather than this answer will keep claiming it alerted someone long after the webhook is revoked —
 * which for a health check means the outage detector's own outage is invisible.
 */
export async function notifyModAlert(title: string, description: string): Promise<boolean> {
  if (!env.DISCORD_WEBHOOK_MOD_ALERTS) return false;

  return fetch(env.DISCORD_WEBHOOK_MOD_ALERTS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{ title, description, color: 0xf44336, timestamp: new Date().toISOString() }],
    }),
  })
    .then((res) => res.ok)
    .catch(() => false);
}
