import { env } from '~/env/server';
import { isConfiguredSecret } from '~/server/utils/configured-secret';

/**
 * The `Authorization` value for the app's own calls to its health routes: `PROBE_TOKEN` when set,
 * else the webhook token, which those routes also accept.
 */
export function probeAuthorization(): string {
  return `Bearer ${isConfiguredSecret(env.PROBE_TOKEN) ? env.PROBE_TOKEN : env.WEBHOOK_TOKEN}`;
}
