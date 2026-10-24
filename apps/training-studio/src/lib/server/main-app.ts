import { env } from '$env/dynamic/private';

const DEFAULT_ORIGIN = 'https://civitai.com';

/** The main app's origin, from `CIVITAI_URL`: the one knob for deep links and server calls alike. */
export function mainAppOrigin(value = env.CIVITAI_URL): string {
  try {
    return new URL(value || DEFAULT_ORIGIN).origin;
  } catch {
    return DEFAULT_ORIGIN;
  }
}

/**
 * The origin to send the user's session cookie to: https only, or a local main app in
 * development. Anything else refuses rather than send it.
 */
export function mainAppSessionOrigin(value = env.CIVITAI_URL): string {
  const url = new URL(mainAppOrigin(value));
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !local)
    throw new Error('CIVITAI_URL must be an https origin to send the session to.');
  return url.origin;
}
