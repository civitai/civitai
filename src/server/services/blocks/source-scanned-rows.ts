import { ensureFliptInitialized, FLIPT_FEATURE_FLAGS, isFliptSync } from '~/server/flipt/client';
import {
  type AppBlockSourceFlag,
  appBlockSourceFlagUnknownCounter,
} from '~/server/prom/app-block-source.metrics';

/**
 * THE one read of `app-block-source-scanned-rows`: whether this app's generation sources must be
 * scanned `Image` rows, so the gate refuses the orchestrator blob urls it sends.
 *
 * Evaluated PER APP — entityId = the app block id, NO context — the same way as
 * `app-blocks-shared-data-moderation`: ramp it by boolean, by
 * percentage (a sticky subset of apps), or with an ENTITY_ID segment listing app block ids. A
 * context-reading segment (moderators, testers, any cohort) matches nothing here.
 *
 * Every reader passes the block token's `appBlockId` claim, so no two surfaces can answer
 * differently for one app; the callers are pinned by `__tests__/source-scanned-rows.ledger.test.ts`.
 *
 * No app block id: `false` without asking Flipt, which is what the flag OFF answers. A flag that
 * cannot be evaluated answers ON ({@link readAppBlockSourceFlag}).
 */
export async function appUsesScannedSourceRows(
  appBlockId: string | null | undefined
): Promise<boolean> {
  if (!appBlockId) return false;
  return readAppBlockSourceFlag('source-scanned-rows', appBlockId);
}

const appBlockSourceFlagKey = (flag: AppBlockSourceFlag): string =>
  flag === 'source-scanned-rows'
    ? FLIPT_FEATURE_FLAGS.APP_BLOCK_SOURCE_SCANNED_ROWS
    : FLIPT_FEATURE_FLAGS.APP_BLOCK_REFUSE_EXTERNAL_SOURCES;

/**
 * An App Blocks source flag, where ON is the stricter answer. A flag that cannot be evaluated (no
 * client and no snapshot, or an evaluation error) answers ON and is counted, never OFF. App Blocks
 * entries only: the site-wide generation flags keep their own reads.
 */
export async function readAppBlockSourceFlag(
  flag: AppBlockSourceFlag,
  entityId?: string
): Promise<boolean> {
  try {
    await ensureFliptInitialized();
  } catch {
    // An unstarted client answers null below.
  }
  const key = appBlockSourceFlagKey(flag);
  const on = entityId === undefined ? isFliptSync(key) : isFliptSync(key, entityId);
  if (on !== null) return on;
  try {
    appBlockSourceFlagUnknownCounter.inc({ flag });
  } catch {
    // Counting must not cost the decision.
  }
  return true;
}
