import { createBuzzClient } from '@civitai/buzz';
import { env } from '$env/dynamic/private';
import { buzzPort, type BuzzPort } from './buzz';

// Lazy: a missing BUZZ_ENDPOINT throws on the first conversion, not at boot.
let port: BuzzPort | undefined;

export function getBuzzPort(): BuzzPort {
  if (!port) port = buzzPort(createBuzzClient({ endpoint: env.BUZZ_ENDPOINT }));
  return port;
}
