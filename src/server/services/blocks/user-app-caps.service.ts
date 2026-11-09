import { DEFAULT_DOC_STORE_LIMITS } from '~/server/services/apps/doc-store.types';
import { BLOCK_BUZZ_CAP_PER_DAY } from '~/shared/constants/block-scope.constants';

export type UserAppCaps = { buzzPerDay: number; docBytes: number; docCount: number };

/**
 * One user's app-platform caps: Buzz spent through apps per UTC day, and document storage per
 * app. Per USER (the viewer's plan), not the per-APP `spendTier` caps in `app-cap-limits.service.ts`;
 * keep the two apart.
 *
 * Every constant today. When the caps key on membership tier, this resolves the tier, and
 * enforcement and display both read it here. Like `resolveAppCapLimits`, it must never throw and,
 * on any failure, must return the strictest caps, never an unbounded one.
 */
export async function resolveUserAppCaps(_userId: number): Promise<UserAppCaps> {
  return {
    buzzPerDay: BLOCK_BUZZ_CAP_PER_DAY,
    docBytes: DEFAULT_DOC_STORE_LIMITS.userBytes,
    docCount: DEFAULT_DOC_STORE_LIMITS.userDocs,
  };
}
