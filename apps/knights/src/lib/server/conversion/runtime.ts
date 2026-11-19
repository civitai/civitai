import { createBuzzClient } from '@civitai/buzz';
import { env } from '$env/dynamic/private';
import { storedSettings } from '../settings/runtime';
import { buzzPort, type BuzzPort } from './buzz';

const switchedOff = (raw: string | undefined) =>
  ['true', '1', 'yes', 'on'].includes((raw ?? '').trim().toLowerCase());

/**
 * Converting gold to Buzz is on unless its kill switch is set: the one saved on the moderator Config page wins, else
 * `KNIGHTS_CONVERSION_DISABLED` is `true`, `1`, `yes` or `on` (any case). Gold still accrues.
 */
export const conversionEnabled = async (): Promise<boolean> =>
  !((await storedSettings()).conversionDisabled ?? switchedOff(env.KNIGHTS_CONVERSION_DISABLED));

/** Closes the shop only, by the same rule as `conversionEnabled` (`KNIGHTS_SHOP_DISABLED`); gold still accrues. Buzz packs have their own switch. */
export const shopEnabled = async (): Promise<boolean> =>
  !((await storedSettings()).shopDisabled ?? switchedOff(env.KNIGHTS_SHOP_DISABLED));

export const buzzConfigured = () => Boolean(env.BUZZ_ENDPOINT);

// Lazy: a missing BUZZ_ENDPOINT throws on the first conversion, not at boot.
let port: BuzzPort | undefined;

export function getBuzzPort(): BuzzPort {
  if (!port) port = buzzPort(createBuzzClient({ endpoint: env.BUZZ_ENDPOINT }));
  return port;
}
