/**
 * Populate Cosmetic.pHash / Cosmetic.pHashUrl for artwork that has no hash, or
 * whose hash describes an image the cosmetic no longer uses.
 *
 * Cosmetic artwork never becomes an Image row, so it has never been perceptually
 * hashed; only an exact sha256 on the shop item guards against re-submission,
 * and a re-encode defeats that. Each row is hashed by submitting a one-step
 * `mediaHash` workflow (see getPerceptualHash) — no Image row, no scan webhook.
 *
 * `pHashUrl` records which `data.url` produced `pHash`. Paths that swap a
 * cosmetic's artwork with a raw UPDATE leave the two disagreeing, which is how
 * this finds a hash that no longer describes the current image. A stale hash is
 * worse than none: matching would compare against artwork that is gone.
 *
 * Requires the pHash/pHashUrl migration to be applied to the target database.
 *
 * Usage:
 *   npm run tsscript scripts/oneoffs/backfill-cosmetic-phash.ts --target=<prod|dev> [options]
 *
 * Options:
 *   --target=prod|dev   REQUIRED. prod reads DATABASE_URL, dev reads DEV_DATABASE_URL.
 *   --dry-run           Report what would be hashed, submit nothing, write nothing.
 *   --batch-size=N      Rows fetched per iteration (default 100).
 *   --concurrency=N     Hash workflows in flight (default 5).
 *   --after-id=N        Resume past this cosmetic id (exclusive).
 *
 * The cursor advances past every row it fetches, including ones that fail, so
 * permanently-unhashable artwork (a url that 404s on the CDN) can't block the
 * rows behind it. Re-run to retry failures; already-hashed rows are skipped by
 * the predicate.
 */
import { PrismaClient } from '@prisma/client';
import { getPerceptualHash } from '~/server/services/orchestrator/orchestrator.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

const TARGETS = {
  prod: 'DATABASE_URL',
  dev: 'DEV_DATABASE_URL',
} as const;

type CosmeticRow = { id: number; url: string; animated: boolean };

function fail(message: string): never {
  console.error(`[backfill-cosmetic-phash] ${message}`);
  process.exit(1);
}

// Hand-rolled rather than a coercion helper: `Boolean('false')` is true, and a
// mistyped flag silently doing the opposite of what was asked is the whole
// reason this parses strictly and rejects anything it doesn't recognise.
function parseArgs(argv: string[]) {
  const known = ['--target', '--dry-run', '--batch-size', '--concurrency', '--after-id'];
  const parsed: Record<string, string> = {};

  for (const arg of argv) {
    const [flag, ...rest] = arg.split('=');
    if (!known.includes(flag)) fail(`Unrecognised argument: ${arg}`);
    parsed[flag] = rest.join('=');
  }

  const target = parsed['--target'];
  if (!target) fail(`--target is required (one of: ${Object.keys(TARGETS).join(', ')})`);
  if (!(target in TARGETS)) fail(`Unrecognised --target: ${target}`);

  const dryRunValue = parsed['--dry-run'];
  if (dryRunValue !== undefined && dryRunValue !== '' && dryRunValue !== 'true') {
    fail(`--dry-run takes no value (got "${dryRunValue}"); omit the flag to run for real`);
  }

  const number = (flag: string, fallback: number) => {
    const raw = parsed[flag];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) fail(`${flag} must be a positive integer`);
    return value;
  };

  return {
    target: target as keyof typeof TARGETS,
    dryRun: '--dry-run' in parsed,
    batchSize: number('--batch-size', 100),
    concurrency: number('--concurrency', 5),
    afterId: number('--after-id', 0),
  };
}

async function main() {
  const { target, dryRun, batchSize, concurrency, afterId } = parseArgs(process.argv.slice(2));

  const envVar = TARGETS[target];
  const databaseUrl = process.env[envVar];
  if (!databaseUrl) fail(`--target=${target} needs ${envVar} to be set`);

  // Say which database this is about to write to before touching it — the
  // target is the one mistake here that isn't recoverable.
  const { host, pathname } = new URL(databaseUrl);
  console.log(
    `[backfill-cosmetic-phash] target=${target} db=${host}${pathname} ` +
      `dryRun=${dryRun} batchSize=${batchSize} concurrency=${concurrency} afterId=${afterId}`
  );

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  try {
    // Type isn't a reliable filter — NamePlate and ContentDecoration are
    // CSS-only — but the presence of data.url is what decides whether there's
    // artwork to hash at all.
    const PENDING_SQL = `
      SELECT
        id,
        data->>'url' AS url,
        COALESCE((data->>'animated')::boolean, false) AS animated
      FROM "Cosmetic"
      WHERE (data->>'url') IS NOT NULL
        AND (data->>'url') <> ''
        AND ("pHash" IS NULL OR "pHashUrl" IS DISTINCT FROM data->>'url')
        AND id > $1
      ORDER BY id
      LIMIT $2`;

    const [{ count }] = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count
       FROM "Cosmetic"
       WHERE (data->>'url') IS NOT NULL
         AND (data->>'url') <> ''
         AND ("pHash" IS NULL OR "pHashUrl" IS DISTINCT FROM data->>'url')
         AND id > $1`,
      afterId
    );
    const total = Number(count);
    console.log(`pending: ${total}`);

    if (dryRun) {
      const sample = await prisma.$queryRawUnsafe<CosmeticRow[]>(PENDING_SQL, afterId, batchSize);
      console.log(
        `dry run — first ${sample.length} of ${total}: ` +
          `ids ${sample.at(0)?.id ?? '-'}..${sample.at(-1)?.id ?? '-'}, ` +
          `${sample.filter((x) => x.animated).length} animated`
      );
      return;
    }

    if (total === 0) return;

    let cursor = afterId;
    let hashed = 0;
    let failed = 0;
    const failedIds: number[] = [];
    const started = Date.now();

    for (;;) {
      const records = await prisma.$queryRawUnsafe<CosmeticRow[]>(PENDING_SQL, cursor, batchSize);
      if (!records.length) break;

      await limitConcurrency(
        records.map((record) => async () => {
          // limitConcurrency rejects the whole run on the first throw, which
          // would discard the tally for every row already done.
          try {
            const pHash = await getPerceptualHash(record.url);
            // `0n` is a real hash (solid-colour artwork), not a miss.
            if (pHash === undefined) {
              failed++;
              failedIds.push(record.id);
              return;
            }
            await prisma.cosmetic.update({
              where: { id: record.id },
              data: { pHash, pHashUrl: record.url },
            });
            hashed++;
          } catch (error) {
            failed++;
            failedIds.push(record.id);
            console.error(
              `  cosmetic ${record.id} (${record.url}): ` +
                (error instanceof Error ? error.message : String(error))
            );
          }
        }),
        concurrency
      );

      // Advance regardless of outcome so unhashable rows don't hold the head of
      // the queue on the next iteration.
      cursor = records[records.length - 1].id;

      const done = hashed + failed;
      const elapsed = (Date.now() - started) / 1000;
      const rate = done / Math.max(elapsed, 0.001);
      console.log(
        `[hash] ${done}/${total} (${((done / total) * 100).toFixed(1)}%) ` +
          `hashed=${hashed} failed=${failed} rate=${rate.toFixed(1)}/s ` +
          `eta=${Math.round((total - done) / Math.max(rate, 0.1))}s cursor=${cursor}`
      );
    }

    console.log(`[backfill-cosmetic-phash] done. hashed=${hashed} failed=${failed}`);
    if (failedIds.length) {
      console.log(`failed ids (first 50): ${failedIds.slice(0, 50).join(', ')}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
