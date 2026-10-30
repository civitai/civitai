import { createBuzzClient } from '@civitai/buzz';
import { env } from '$env/dynamic/private';
import { buzzPort, type BuzzPort } from './buzz';

/** Converting gold to Buzz is off unless `KNIGHTS_CONVERSION_ENABLED` is exactly `true`. Gold still accrues. */
export const conversionEnabled = () => env.KNIGHTS_CONVERSION_ENABLED === 'true';

export const buzzConfigured = () => Boolean(env.BUZZ_ENDPOINT);

// Lazy: a missing BUZZ_ENDPOINT throws on the first conversion, not at boot.
let port: BuzzPort | undefined;

export function getBuzzPort(): BuzzPort {
  if (!port) port = buzzPort(createBuzzClient({ endpoint: env.BUZZ_ENDPOINT }));
  return port;
}
