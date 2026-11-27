import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';

/** Staff platform updates' global switch (`app-platform-update.service.ts` re-exports both). */
export const PLATFORM_UPDATES_FLAG = FLIPT_FEATURE_FLAGS.APP_BLOCKS_PLATFORM_UPDATES;

/** The global switch. Off, absent or Flipt unreachable ⇒ off. */
export async function isPlatformUpdatesEnabled(): Promise<boolean> {
  return isFlipt(PLATFORM_UPDATES_FLAG).catch(() => false);
}
