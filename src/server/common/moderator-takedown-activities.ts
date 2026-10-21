/**
 * 🔴 The POSITIVE signal that a human moderator took THIS ONE IMAGE down. It is the only thing
 * that unlocks blob retraction, in `remove-blocked-images` (`src/server/jobs/image-ingestion.ts`;
 * see the long note at the split there for why the discriminator has to be positive rather than an
 * opt-out) and in the takedown CDN sync (`cdn-access.service.ts`). The `trg_cdn_access_mod_activity`
 * trigger (migration `20261111120000_cdn_access_sync`) lists the same values.
 *
 * Both values are `ModActivity.activity` rows written against `entityType = 'image'`. Enumerated
 * over every `trackModActivity`/`recordModActivity` call in `src` and `apps` that carries
 * `entityType: 'image'`, the complete vocabulary is:
 *   'review'        — `handleUnblockImages` and `handleBlockImages` (image.service),
 *                     `setTosViolationHandler` (image.controller), `acceptImage` and `blockImage`
 *                     (moderator app), `/api/mod/unblock-images`. Every one of them writes one row
 *                     per NAMED image id — several of them take a list, but none of them stands in
 *                     for a set it was never handed. Three of the six are the un-block direction,
 *                     which is why the timestamp comparison at the call site is load-bearing and
 *                     not decoration — and it is worth being exact about what that comparison
 *                     does, because the obvious reading of it is wrong. It compares the activity
 *                     against the QUEUE ROW's `createdAt`, not against the re-block, and
 *                     `create_job_queue_record` is `ON CONFLICT DO NOTHING`: a queue row that
 *                     survives an un-block keeps the FIRST block's timestamp, so an un-block dated
 *                     after it reads as a takedown. What closes that is the un-block writers
 *                     dropping the queue row: `handleUnblockImages` and `/api/mod/unblock-images`
 *                     call `dropBlockedImageDeleteQueue`, and the moderator app's `acceptImage`
 *                     and appeal approval drop it the same way, leaving nothing to compare
 *                     against. See the ── WHERE THIS IS DELIBERATELY IMPRECISE ── note in
 *                     `image-ingestion.ts` for what remains.
 *   'bulkRemove'    — the moderator app's `removeImages`, one row per image from an explicit id
 *                     list. Its sibling `removeAllImagesForUser` (the whole-account nuke) writes
 *                     NO per-image row, by its own design; that is what keeps a library-wide block
 *                     out of this set.
 * DELIBERATELY EXCLUDED — the rest of that enumeration, every one of them moderator-written and
 * none of them a decision to destroy the bytes: 'bulkRestore', 'resolveAppeal', 'setNsfwLevel',
 * 'setNsfwLevelKono' and 'moderateTag', plus the flag activities the moderator app spells
 * dynamically as `poi:<bool>` / `minor:<bool>`.
 *
 * Adding a value here widens who can trigger a retraction. Say why, in the same commit.
 */
export const MODERATOR_TAKEDOWN_ACTIVITIES = ['review', 'bulkRemove'] as const;
