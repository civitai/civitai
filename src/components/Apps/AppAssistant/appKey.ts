import { SLUG_REGEX } from '~/server/schema/blocks/publish-request.schema';

/** The hosted sandbox service accepts an app key of 1–200 characters and nothing stricter. */
export const APP_KEY_MAX_LENGTH = 200;

/** Why `key` would be refused, or `null` when the sandbox service accepts it. */
export function appKeyError(key: string): string | null {
  if (key.trim().length === 0) return 'Enter a name for the app';
  if (key.length > APP_KEY_MAX_LENGTH)
    return `Keep it to ${APP_KEY_MAX_LENGTH} characters or fewer`;
  return null;
}

/**
 * Whether `key` can also be the app's `blockId`, which a live preview needs: the same rule submit
 * and the dev tunnel enforce on a slug.
 */
export function isAppBlockId(key: string): boolean {
  return key.length >= 3 && key.length <= 40 && SLUG_REGEX.test(key);
}
