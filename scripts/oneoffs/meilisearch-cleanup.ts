/**
 * Meilisearch stale-document cleanup (manual runner).
 *
 * Scans each configured Meilisearch index, checks every id against Postgres
 * using the same WHERE clause the index uses when it pulls data, and deletes
 * docs that no longer qualify. Shared logic lives in
 * `src/server/meilisearch/cleanup.ts` and is also wired as a daily job.
 *
 * Skipped: images_v6 and metrics_images_v1 (images aren't being updated).
 *
 * Usage:
 *   pnpm tsscript scripts/oneoffs/meilisearch-cleanup.ts             # dry-run small sample
 *   pnpm tsscript scripts/oneoffs/meilisearch-cleanup.ts --apply     # full run, deletes
 *   pnpm tsscript scripts/oneoffs/meilisearch-cleanup.ts --index=models,articles
 *   pnpm tsscript scripts/oneoffs/meilisearch-cleanup.ts --concurrency=16 --batch=1000
 *   pnpm tsscript scripts/oneoffs/meilisearch-cleanup.ts --sample=10   # dry-run batch count
 */

import {
  CLEANUP_INDEXES,
  cleanupAllIndexes,
  type CleanupIndexKey,
} from '~/server/meilisearch/cleanup';
import { searchClient } from '~/server/meilisearch/client';

type Args = {
  apply: boolean;
  indexes: CleanupIndexKey[] | null;
  concurrency: number;
  batch: number;
  sample: number;
};

function parseArgs(): Args {
  const raw = process.argv.slice(2);
  const apply = raw.includes('--apply');
  const get = (name: string) => {
    const hit = raw.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=')[1] : undefined;
  };
  const indexesArg = get('index');
  const indexes = indexesArg
    ? (indexesArg.split(',').map((s) => s.trim()).filter(Boolean) as CleanupIndexKey[])
    : null;
  const concurrency = Number(get('concurrency') ?? 8);
  const batch = Number(get('batch') ?? 1000);
  const sample = Number(get('sample') ?? 5);
  return { apply, indexes, concurrency, batch, sample };
}

async function main() {
  if (!searchClient) {
    throw new Error('searchClient not configured (SEARCH_HOST / SEARCH_API_KEY missing)');
  }
  const args = parseArgs();
  const validKeys = new Set(CLEANUP_INDEXES.map((i) => i.key));
  if (args.indexes) {
    const missing = args.indexes.filter((k) => !validKeys.has(k));
    if (missing.length) throw new Error(`Unknown index key(s): ${missing.join(', ')}`);
  }

  const selectedKeys = args.indexes ?? CLEANUP_INDEXES.map((i) => i.key);
  console.log(
    `Meilisearch cleanup starting.\n` +
      `  indexes: ${selectedKeys.join(', ')}\n` +
      `  mode: ${args.apply ? 'APPLY (will delete)' : 'DRY-RUN (no deletes)'}\n` +
      `  concurrency: ${args.concurrency}\n` +
      `  batch: ${args.batch}\n` +
      (args.apply ? '' : `  sample batches: ${args.sample}\n`)
  );

  const results = await cleanupAllIndexes(args.indexes, {
    apply: args.apply,
    concurrency: args.concurrency,
    batch: args.batch,
    maxBatches: args.apply ? undefined : args.sample,
    onBatch: ({ key, offset, scanned, stale }) => {
      if (stale === 0) return;
      console.log(`  [${key}] offset=${offset} batch=${scanned} stale=${stale}`);
    },
    onDelete: ({ key, chunk, ids }) => {
      console.log(`  [${key}] delete-chunk #${chunk} submitted: ${ids} ids`);
    },
    onError: ({ key, offset, error }) => {
      const where = offset === -1 ? 'delete phase' : `batch at offset ${offset}`;
      console.error(`  [${key}] ${where} failed:`, error.message);
    },
  });

  console.log('\n=== Summary ===');
  for (const s of results) {
    const pct =
      s.idsScanned > 0 ? ((s.staleFound / s.idsScanned) * 100).toFixed(2) : '0.00';
    console.log(
      `  ${s.key.padEnd(12)} scanned=${s.idsScanned} stale=${s.staleFound} (${pct}%) ` +
        `deleted=${s.deleted} errors=${s.errors} total=${s.totalInIndex ?? '?'}`
    );
  }

  if (!args.apply) {
    console.log(
      `\nDry-run complete. Re-run with --apply to delete stale docs for the selected indexes.`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
