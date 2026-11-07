import { createBuzzClient } from '@civitai/buzz';
import { env } from '$env/dynamic/private';
import { buzzPort, type BuzzPort } from './buzz';

/** Converting gold to Buzz is on unless the `KNIGHTS_CONVERSION_DISABLED` kill switch is `true`, `1`, `yes` or `on` (any case). Gold still accrues. */
export const conversionEnabled = () =>
  !['true', '1', 'yes', 'on'].includes(
    (env.KNIGHTS_CONVERSION_DISABLED ?? '').trim().toLowerCase()
  );

/** Closes the shop only; gold still accrues. Buzz packs have their own switch, `conversionEnabled()`. */
export const shopEnabled = () =>
  !['true', '1', 'yes', 'on'].includes((env.KNIGHTS_SHOP_DISABLED ?? '').trim().toLowerCase());

export const buzzConfigured = () => Boolean(env.BUZZ_ENDPOINT);

// Lazy: a missing BUZZ_ENDPOINT throws on the first conversion, not at boot.
let port: BuzzPort | undefined;

export function getBuzzPort(): BuzzPort {
  if (!port) port = buzzPort(createBuzzClient({ endpoint: env.BUZZ_ENDPOINT }));
  return port;
}
