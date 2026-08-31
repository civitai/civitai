/**
 * Drain the whole `Cosmetic` corpus into the current `COSMETIC_PHASH_LANE` in one
 * run, instead of waiting out the 15-minute `cosmetic-phash-sweep` cron.
 *
 * Run it right after deploying a lane bump:
 *   pnpm ts-script scripts/oneoffs/drain-cosmetic-phash-lane.ts
 *
 * ── WHY THIS EXISTS AT ALL ────────────────────────────────────────────────
 *
 * The sweep already drains a lane change on its own — it selects on
 * `pHashVersion IS DISTINCT FROM` the constant, so raising the lane IS the
 * backfill and this script is never load-bearing. What it buys is the *shape of
 * the gap*, not the total time.
 *
 * While the corpus straddles two lanes, `getSimilarCosmetics` filters candidates
 * on `pHashVersion = <lane>` AND on hash width. A cosmetic that has already been
 * re-hashed is therefore compared only against the other re-hashed rows — a
 * ranking over a fraction of the library, with no error, no width mismatch and
 * nothing on screen to say so. At 200 rows per tick a ~1,740-row corpus sits in
 * that state for about two and a quarter hours.
 *
 * That matters more than it looks, because the panel is NOT dark. Flipt
 * `cosmetic-similarity` is `enabled: false`, but `enabled` is the value returned
 * when no rollout matches, and the `moderators → true` rollout does match (see
 * `packages/civitai-flipt/src/context.ts`). Moderators can see the panel today.
 * A partial ranking presented to the person deciding whether artwork is stolen is
 * the failure this whole feature exists to prevent, so crossing that window in
 * minutes rather than hours is worth one manual step.
 *
 * ── WHY IT DELEGATES INSTEAD OF WRITING SQL ───────────────────────────────
 *
 * It calls `sweepCosmeticPerceptualHashes` in a loop rather than issuing its own
 * UPDATE. Every rule about what a correct row looks like — the legacy `pHash`
 * left null once a hash no longer fits a BIGINT, `pHashUrl` recording what was
 * actually hashed rather than what the cosmetic currently points at, the failure
 * stamp cleared on success and set only on failure — lives in
 * `storeCosmeticPerceptualHash`, is tested there, and would have to be restated
 * here to be got wrong independently. A hand-rolled backfill is how the two
 * drift.
 *
 * Consequences of that choice, both deliberate:
 *   - It is idempotent and resumable. Interrupt it and re-run it; rows already in
 *     the lane no longer match the predicate.
 *   - It cannot get stuck on dead artwork. A row that fails is stamped and drops
 *     out of the predicate for 24h, which is what terminates the loop rather than
 *     a retry count.
 */
import { sweepCosmeticPerceptualHashes } from '~/server/jobs/cosmetic-phash-sweep';
import { COSMETIC_PHASH_LANE } from '~/server/services/cosmetic-phash.service';

// The cron's own numbers, deliberately, rather than something faster. The speed
// here comes from removing the 15-minute gap between ticks, not from working a
// tick harder — the corpus drains in a few minutes either way.
//
// Raising concurrency would actively defeat the point. `getPerceptualHash`
// returns `undefined` both for a real failure and for a workflow still running
// at its 30s wait, and the sweep cannot tell those apart: either way the row is
// counted `failed` and stamped `pHashFailedAt`, which suppresses it for 24h.
// More concurrency means more timeouts, so a script whose whole purpose is
// shortening the window a row spends outside the lane would EXTEND it to a day
// for some slice of the corpus — and then print "done", because a stamped row
// drops out of the predicate and the next batch comes back empty.
const BATCH_SIZE = 200;
const CONCURRENCY = 5;

// A stop, not a target. The loop ends when a batch comes back empty; this only
// bounds a predicate that never drains — a bug in the sweep, or artwork being
// created faster than it is hashed — so the script exits loudly instead of
// hashing forever. 20 × 200 is ~2x the current corpus: enough slack to finish,
// small enough that a runaway is caught before it has spent thousands of hashes.
const MAX_BATCHES = 20;

async function main() {
  console.log(`[drain] lane ${COSMETIC_PHASH_LANE.version} (${COSMETIC_PHASH_LANE.hexLength} hex)`);

  let batches = 0;
  let hashed = 0;
  let failed = 0;

  for (;;) {
    if (batches >= MAX_BATCHES) {
      console.error(
        `[drain] STOPPED after ${MAX_BATCHES} batches with work still outstanding. ` +
          `The predicate is not draining — check the orchestrator before re-running.`
      );
      process.exitCode = 1;
      return;
    }

    const result = await sweepCosmeticPerceptualHashes({
      batchSize: BATCH_SIZE,
      concurrency: CONCURRENCY,
    });
    if (result.scanned === 0) break;

    batches++;
    hashed += result.hashed;
    failed += result.failed;
    console.log(
      `[drain] batch ${batches}: scanned ${result.scanned}, hashed ${result.hashed}, failed ${result.failed}`
    );
  }

  // Say what the number IS, not what caused it. `failed` counts rows the sweep
  // could not store on this run, and it cannot distinguish between them: dead CDN
  // artwork, an orchestrator still working when the 30s wait elapsed, and a hash
  // the store refused all land here identically. Naming any one of those as the
  // cause would be a guess printed in the voice of a measurement — and the
  // operator's next move differs for each (nothing, re-run, fix the lane).
  //
  // Two earlier drafts of the line below each asserted a cause the count cannot
  // support — first "permanently unhashable", then "the cause is not recorded".
  // Both were wrong, in opposite directions, so the coverage is spelt out here:
  //
  //   LOGGED as `perceptual-hash`      a relative media url (this is a script, so
  //                                    NEXT_PUBLIC_IMAGE_LOCATION can be unset),
  //                                    and any network error or abort
  //                                    (orchestrator.service.ts:284, :322)
  //   LOGGED as `cosmetic-phash-sweep` the store refused the hash — a width that
  //                                    disagrees with the lane
  //   NOT LOGGED AT ALL                a workflow that simply did not succeed
  //                                    (orchestrator.service.ts:318) — which is
  //                                    both the 30s-wait timeout and dead artwork
  //
  // So the operator gets records for some rows and nothing for others, and the
  // two that are silent are the two most likely. Say that, rather than implying
  // Axiom explains everything or that it explains nothing. Re-running is the only
  // thing that separates a timeout from dead artwork, and it must be after the
  // 24h stamp expires — 24 hours, not "tomorrow": an early re-run finds an empty
  // predicate and prints a clean zero, which reads as all-clear.
  console.log(`[drain] done — ${hashed} hashed, ${failed} not stored this run, ${batches} batches`);
  if (failed > 0)
    console.log(
      `[drain] ${failed} row(s) failed and are suppressed for the next 24h; this count cannot tell ` +
        `dead artwork from a timeout from a hash the store refused. Re-run once 24h have elapsed ` +
        `(sooner and every row is still suppressed, so it reports a clean zero): a timeout hashes ` +
        `then. A row failing repeatedly is dead artwork OR a lane/env problem — check Axiom ` +
        `'perceptual-hash' and 'cosmetic-phash-sweep', which cover the error paths but not a ` +
        `workflow that never succeeded.`
    );
}

main()
  .catch((error) => {
    console.error('[drain] failed', error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
