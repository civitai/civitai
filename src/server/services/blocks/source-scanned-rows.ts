import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';

/**
 * THE one read of `app-block-source-scanned-rows`: whether this app's generation sources must be
 * scanned `Image` rows, so the gate refuses the orchestrator blob urls it sends.
 *
 * Evaluated PER APP — entityId = the app block id, NO context — the same way as
 * `app-blocks-storage-publish` and `app-blocks-shared-data-moderation`: ramp it by boolean, by
 * percentage (a sticky subset of apps), or with an ENTITY_ID segment listing app block ids. A
 * context-reading segment (moderators, testers, any cohort) matches nothing here.
 *
 * Every reader goes through this function, and each passes the app block id from the same place,
 * the block token's `appBlockId` claim (a dev token's is its own, synthetic or real, as for the
 * other per-app flags):
 *   - `blockImageUpload.generationSourceUsesScannedRows`, which path the host's picker takes;
 *   - `blocks.persistUploadedGenerationSource`, which refuses while this is off;
 *   - the generation gate (`assertGenerationInputsUsable`, `countAppBlockHostSources`).
 * So the picker, the copy and the gate cannot answer differently for one app. The set of callers
 * is pinned by `__tests__/source-scanned-rows.ledger.test.ts`.
 *
 * No app block id: `false` without asking Flipt, which is what the flag OFF answers.
 */
export async function appUsesScannedSourceRows(
  appBlockId: string | null | undefined
): Promise<boolean> {
  if (!appBlockId) return false;
  return isFlipt(FLIPT_FEATURE_FLAGS.APP_BLOCK_SOURCE_SCANNED_ROWS, appBlockId);
}
