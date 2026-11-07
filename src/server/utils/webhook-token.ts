import { env } from '~/env/server';
import { isConfiguredSecret } from '~/server/utils/configured-secret';
import { timingSafeEqualStrings } from '~/server/utils/timing-safe-equal';

/**
 * Which configured webhook token a presented value is. `previous` is `WEBHOOK_TOKEN_PREVIOUS`,
 * accepted alongside `WEBHOOK_TOKEN` so the value can change without every caller switching at the
 * same moment. Unset or blank, it matches nothing.
 */
export type WebhookTokenSlot = 'current' | 'previous';

/** A matched slot as counted: a webhook token, or `PROBE_TOKEN` on the health routes. */
export type TokenMatchSlot = WebhookTokenSlot | 'probe';

export function matchWebhookToken(presented: unknown): WebhookTokenSlot | undefined {
  if (typeof presented !== 'string') return undefined;
  const current = env.WEBHOOK_TOKEN;
  if (isConfiguredSecret(current) && timingSafeEqualStrings(current, presented)) return 'current';
  const previous = env.WEBHOOK_TOKEN_PREVIOUS;
  if (isConfiguredSecret(previous) && timingSafeEqualStrings(previous, presented))
    return 'previous';
  return undefined;
}

/** `PROBE_TOKEN`, which only the health routes accept. Unset or blank, it matches nothing. */
export function matchProbeToken(presented: unknown): 'probe' | undefined {
  if (typeof presented !== 'string') return undefined;
  const probe = env.PROBE_TOKEN;
  return isConfiguredSecret(probe) && timingSafeEqualStrings(probe, presented)
    ? 'probe'
    : undefined;
}

/** Every configured webhook token value, for code that must refuse to treat one as something else. */
export function webhookTokenValues(): string[] {
  return [env.WEBHOOK_TOKEN, env.WEBHOOK_TOKEN_PREVIOUS].filter(isConfiguredSecret);
}
