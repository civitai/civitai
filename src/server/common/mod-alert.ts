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
 * `postDiscordAlert` is the same delivery to any webhook with a chosen `color`; the training canary
 * posts to its own channel through it, and `new-order-jobs.ts` could adopt it unchanged. The other
 * three (`git-push.ts`, `publish-request.service.ts`, `apps-shared.router.ts`) build `fields[]`
 * embeds with `url`/`footer` and are a genuinely different shape; the latter two also resolve `env`
 * through `await import`, so they would not adopt this unchanged even if the shape matched.
 */
export type ModAlertOutcome = 'delivered' | 'rejected' | 'unconfigured';

/**
 * @returns what happened, not merely whether it worked. `rejected` and `unconfigured` are different
 * facts and a caller that collapses them reports a delivery failure in every environment that never
 * had a webhook — which for a health check means its own alarm cries wolf exactly where nobody can
 * act on it. A caller reporting "paged" off its own intent instead of this answer keeps claiming it
 * alerted someone long after the webhook is revoked.
 */
export async function notifyModAlert(title: string, description: string): Promise<ModAlertOutcome> {
  return postDiscordAlert(env.DISCORD_WEBHOOK_MOD_ALERTS, { title, description });
}

/** Same delivery as `notifyModAlert`, to any Discord webhook and with a chosen embed colour. */
export async function postDiscordAlert(
  webhookUrl: string | undefined,
  { title, description, color = 0xf44336 }: { title: string; description: string; color?: number }
): Promise<ModAlertOutcome> {
  if (!webhookUrl) return 'unconfigured';

  return fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{ title, description, color, timestamp: new Date().toISOString() }],
    }),
  })
    .then((res) => (res.ok ? ('delivered' as const) : ('rejected' as const)))
    .catch(() => 'rejected' as const);
}
