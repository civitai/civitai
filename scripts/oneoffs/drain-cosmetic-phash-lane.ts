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

// Larger than the cron's 200/5 because nothing else is competing for the run.
// Concurrency is the orchestrator's limit, not ours — 10 measured ~10.5 hashes/s.
const BATCH_SIZE = 500;
const CONCURRENCY = 10;

// A stop, not a target. The loop ends when a batch comes back empty; this only
// bounds a predicate that never drains — a bug in the sweep, or artwork being
// created faster than it is hashed — so the script exits loudly instead of
// hashing forever.
const MAX_BATCHES = 40;

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

  // `failed` is expected to be non-zero and is not an error: artwork whose CDN
  // object no longer resolves can never be hashed, and those rows are stamped so
  // they stop starving the ones behind them. Printed rather than swallowed so the
  // count is compared against the known-dead set instead of being discovered later.
  console.log(
    `[drain] done — ${hashed} hashed, ${failed} permanently unhashable, ${batches} batches`
  );
}

main()
  .catch((error) => {
    console.error('[drain] failed', error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
