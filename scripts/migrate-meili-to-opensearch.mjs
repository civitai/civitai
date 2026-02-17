#!/usr/bin/env node

/**
 * Migrate metrics-images documents from Meilisearch to OpenSearch.
 *
 * Pulls documents from the metrics_images_v1 Meilisearch index by ID range
 * and bulk-indexes them into OpenSearch. Much faster than rebuilding from
 * the database since the data is already denormalized.
 *
 * Usage:
 *   node scripts/migrate-meili-to-opensearch.mjs --start 1 --end 1000000
 *   node scripts/migrate-meili-to-opensearch.mjs --start 1 --end 1000000 --batch 5000
 *   node scripts/migrate-meili-to-opensearch.mjs --start 1 --end 1000000 --opensearch-host http://prod-os:9200
 *   node scripts/migrate-meili-to-opensearch.mjs --count  # Just count total docs
 *   node scripts/migrate-meili-to-opensearch.mjs --ensure-index  # Create/update index mappings only
 *
 * Options:
 *   --start <id>              Start of ID range (inclusive)
 *   --end <id>                End of ID range (inclusive)
 *   --batch <size>            Meilisearch fetch batch size (default: 1000, max: 1000)
 *   --push-batch <size>       OpenSearch bulk push batch size (default: 2000)
 *   --concurrency <n>         Parallel Meilisearch fetches (default: 3)
 *   --opensearch-host <url>   Override OPENSEARCH_HOST env var
 *   --opensearch-key <key>    Override OPENSEARCH_API_KEY env var
 *   --meili-host <url>        Override METRICS_SEARCH_HOST env var
 *   --meili-key <key>         Override METRICS_SEARCH_API_KEY env var
 *   --index <name>            OpenSearch target index (default: metrics_images_v1)
 *   --count                   Just count documents in range, don't migrate
 *   --ensure-index            Create/update the OpenSearch index mappings, then exit
 *   --dry-run                 Pull from Meilisearch but don't push to OpenSearch
 *   --quiet                   Suppress per-batch logging
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

// ─── Load env ────────────────────────────────────────────────────────────────

function loadEnv() {
  const envFiles = [
    resolve(projectRoot, '.env.development.local'),
    resolve(projectRoot, '.env.local'),
    resolve(projectRoot, '.env.development'),
    resolve(projectRoot, '.env'),
  ];

  for (const envPath of envFiles) {
    try {
      const content = readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    } catch {
      // File doesn't exist, skip
    }
  }
}

loadEnv();

// ─── Parse args ──────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    start: undefined,
    end: undefined,
    batch: 1000,
    pushBatch: 2000,
    concurrency: 3,
    opensearchHost: process.env.OPENSEARCH_HOST || 'http://localhost:9200',
    opensearchKey: process.env.OPENSEARCH_API_KEY || '',
    meiliHost: process.env.METRICS_SEARCH_HOST,
    meiliKey: process.env.METRICS_SEARCH_API_KEY,
    index: 'metrics_images_v1',
    count: false,
    ensureIndex: false,
    dryRun: false,
    quiet: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--start': opts.start = parseInt(args[++i]); break;
      case '--end': opts.end = parseInt(args[++i]); break;
      case '--batch': opts.batch = Math.min(parseInt(args[++i]), 1000); break;
      case '--push-batch': opts.pushBatch = parseInt(args[++i]); break;
      case '--concurrency': opts.concurrency = parseInt(args[++i]); break;
      case '--opensearch-host': opts.opensearchHost = args[++i]; break;
      case '--opensearch-key': opts.opensearchKey = args[++i]; break;
      case '--meili-host': opts.meiliHost = args[++i]; break;
      case '--meili-key': opts.meiliKey = args[++i]; break;
      case '--index': opts.index = args[++i]; break;
      case '--count': opts.count = true; break;
      case '--ensure-index': opts.ensureIndex = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--help': case '-h':
        console.log(`
Usage: node scripts/migrate-meili-to-opensearch.mjs [options]

Options:
  --start <id>              Start of ID range (inclusive, required for migrate)
  --end <id>                End of ID range (inclusive, required for migrate)
  --batch <size>            Meilisearch fetch batch (default: 1000, max: 1000)
  --push-batch <size>       OpenSearch bulk push batch (default: 2000)
  --concurrency <n>         Parallel Meilisearch fetches (default: 3)
  --opensearch-host <url>   OpenSearch host (default: OPENSEARCH_HOST or http://localhost:9200)
  --opensearch-key <key>    OpenSearch API key (default: OPENSEARCH_API_KEY)
  --meili-host <url>        Meilisearch host (default: METRICS_SEARCH_HOST)
  --meili-key <key>         Meilisearch API key (default: METRICS_SEARCH_API_KEY)
  --index <name>            Target index name (default: metrics_images_v1)
  --count                   Count documents in range only
  --ensure-index            Create/update OpenSearch index mappings
  --dry-run                 Pull from Meilisearch, skip OpenSearch push
  --quiet                   Suppress per-batch logging
`);
        process.exit(0);
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  return opts;
}

const opts = parseArgs();

// ─── Validate ────────────────────────────────────────────────────────────────

if (!opts.meiliHost || !opts.meiliKey) {
  console.error('Error: METRICS_SEARCH_HOST and METRICS_SEARCH_API_KEY must be set (env or --meili-host/--meili-key)');
  process.exit(1);
}

if (!opts.count && !opts.ensureIndex && (opts.start === undefined || opts.end === undefined)) {
  console.error('Error: --start and --end are required for migration. Use --count to check document count.');
  process.exit(1);
}

// ─── Index mappings (copied from metrics-images.mappings.ts) ─────────────────

const metricsImagesMappings = {
  properties: {
    id: { type: 'integer' },
    index: { type: 'integer' },
    postId: { type: 'integer' },
    url: { type: 'keyword' },
    nsfwLevel: { type: 'integer' },
    aiNsfwLevel: { type: 'integer' },
    combinedNsfwLevel: { type: 'integer' },
    nsfwLevelLocked: { type: 'boolean' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    hash: { type: 'keyword' },
    hideMeta: { type: 'boolean' },
    sortAt: { type: 'date' },
    sortAtUnix: { type: 'long' },
    type: { type: 'keyword' },
    userId: { type: 'integer' },
    publishedAtUnix: { type: 'long' },
    existedAtUnix: { type: 'long' },
    hasMeta: { type: 'boolean' },
    hasPositivePrompt: { type: 'boolean' },
    onSite: { type: 'boolean' },
    postedToId: { type: 'integer' },
    needsReview: { type: 'keyword' },
    minor: { type: 'boolean' },
    poi: { type: 'boolean' },
    acceptableMinor: { type: 'boolean' },
    blockedFor: { type: 'keyword' },
    remixOfId: { type: 'integer' },
    availability: { type: 'keyword' },
    baseModel: { type: 'keyword' },
    modelVersionIds: { type: 'integer' },
    modelVersionIdsManual: { type: 'integer' },
    toolIds: { type: 'integer' },
    techniqueIds: { type: 'integer' },
    tagIds: { type: 'integer' },
    reactionCount: { type: 'integer' },
    commentCount: { type: 'integer' },
    collectedCount: { type: 'integer' },
    flags: {
      properties: {
        promptNsfw: { type: 'boolean' },
      },
    },
  },
};

const metricsImagesSettings = {
  number_of_shards: 1,
  number_of_replicas: 0,
};

// ─── Meilisearch client (lightweight, no SDK needed) ─────────────────────────

async function meiliGetDocuments(filter, { limit = 1000, offset = 0, sort } = {}) {
  const params = { filter, limit, offset };
  if (sort) params.sort = sort;

  const url = `${opts.meiliHost}/indexes/metrics_images_v1/documents/fetch`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${opts.meiliKey}`,
    },
    body: JSON.stringify(params),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Meilisearch error ${resp.status}: ${text}`);
  }

  return resp.json();
}

// ─── OpenSearch client (lightweight fetch-based) ─────────────────────────────

function osHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.opensearchKey) {
    headers['Authorization'] = `Bearer ${opts.opensearchKey}`;
  }
  return headers;
}

async function osRequest(method, path, body) {
  const url = `${opts.opensearchHost}${path}`;
  const init = {
    method,
    headers: osHeaders(),
  };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const resp = await fetch(url, init);
  const text = await resp.text();

  let json;
  try { json = JSON.parse(text); } catch { json = text; }

  if (!resp.ok && resp.status !== 404) {
    throw new Error(`OpenSearch ${method} ${path} failed (${resp.status}): ${text}`);
  }

  return { status: resp.status, body: json };
}

async function osEnsureIndex() {
  const { status } = await osRequest('HEAD', `/${opts.index}`);

  if (status === 404) {
    console.log(`Creating index "${opts.index}"...`);
    await osRequest('PUT', `/${opts.index}`, {
      settings: metricsImagesSettings,
      mappings: metricsImagesMappings,
    });
    console.log('Index created.');
  } else {
    console.log(`Index "${opts.index}" exists. Updating mappings...`);
    await osRequest('PUT', `/${opts.index}/_mapping`, metricsImagesMappings);
    console.log('Mappings updated.');
  }
}

async function osBulkIndex(docs) {
  if (docs.length === 0) return { errors: 0, indexed: 0 };

  // Build NDJSON body
  const lines = [];
  for (const doc of docs) {
    lines.push(JSON.stringify({ index: { _index: opts.index, _id: String(doc.id) } }));
    lines.push(JSON.stringify(doc));
  }
  const ndjson = lines.join('\n') + '\n';

  const { body } = await osRequest('POST', '/_bulk', ndjson);

  let errors = 0;
  if (body.errors) {
    errors = body.items.filter(item => item.index?.error).length;
  }

  return { errors, indexed: docs.length - errors };
}

async function osGetCount() {
  try {
    const { body } = await osRequest('GET', `/${opts.index}/_count`);
    return body.count ?? 0;
  } catch {
    return 0;
  }
}

// ─── Core migration logic ────────────────────────────────────────────────────

async function countDocsInRange(start, end) {
  // Meilisearch doesn't have a count API, so we fetch with limit 0 workaround
  // Actually, we'll just do a small fetch to confirm docs exist and estimate
  // Pull page by page to count (limit of 1 per page for counting)
  let total = 0;
  const rangeSize = end - start + 1;
  const sampleBatchSize = 1000;

  // Sample at regular intervals to estimate
  console.log(`Counting documents in ID range ${start} - ${end}...`);

  let offset = 0;
  while (true) {
    const filter = `id >= ${start} AND id <= ${end}`;
    const resp = await meiliGetDocuments(filter, {
      limit: sampleBatchSize,
      offset,
      sort: ['id:asc'],
    });

    total += resp.results.length;

    if (resp.results.length < sampleBatchSize) break;
    offset += sampleBatchSize;

    if (!opts.quiet && offset % 10000 === 0) {
      process.stdout.write(`  counted ${total.toLocaleString()} so far...\r`);
    }
  }

  return total;
}

async function fetchBatch(startId, endId, offset) {
  const filter = `id >= ${startId} AND id <= ${endId}`;
  return meiliGetDocuments(filter, {
    limit: opts.batch,
    offset,
    sort: ['id:asc'],
  });
}

async function migrateRange(start, end) {
  const totalRange = end - start + 1;
  console.log(`\nMigrating ID range: ${start.toLocaleString()} - ${end.toLocaleString()} (range size: ${totalRange.toLocaleString()})`);
  console.log(`  Meilisearch batch: ${opts.batch} | OpenSearch push batch: ${opts.pushBatch} | Concurrency: ${opts.concurrency}`);
  if (opts.dryRun) console.log('  ** DRY RUN — not pushing to OpenSearch **');

  // We'll sweep through the range in sub-ranges to enable concurrency.
  // Each sub-range is processed independently via offset-based pagination.
  const subRangeSize = Math.ceil(totalRange / opts.concurrency);

  let totalPulled = 0;
  let totalIndexed = 0;
  let totalErrors = 0;
  const startTime = Date.now();

  // Accumulator for push batching
  let pushBuffer = [];

  async function flushBuffer() {
    if (pushBuffer.length === 0) return;
    if (opts.dryRun) {
      totalIndexed += pushBuffer.length;
      pushBuffer = [];
      return;
    }

    // Push in chunks of pushBatch
    while (pushBuffer.length > 0) {
      const chunk = pushBuffer.splice(0, opts.pushBatch);
      const { errors, indexed } = await osBulkIndex(chunk);
      totalIndexed += indexed;
      totalErrors += errors;
    }
  }

  // Process sub-ranges concurrently
  const subRanges = [];
  for (let i = 0; i < opts.concurrency; i++) {
    const subStart = start + (i * subRangeSize);
    const subEnd = Math.min(subStart + subRangeSize - 1, end);
    if (subStart > end) break;
    subRanges.push({ subStart, subEnd });
  }

  // Process each sub-range with offset-based pagination
  async function processSubRange({ subStart, subEnd }) {
    let offset = 0;
    while (true) {
      const resp = await fetchBatch(subStart, subEnd, offset);
      const docs = resp.results;

      if (docs.length === 0) break;

      totalPulled += docs.length;
      pushBuffer.push(...docs);

      // Flush when buffer exceeds push batch size
      if (pushBuffer.length >= opts.pushBatch) {
        await flushBuffer();
      }

      if (!opts.quiet) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = Math.round(totalPulled / (elapsed || 1));
        process.stdout.write(
          `  Pulled: ${totalPulled.toLocaleString()} | Indexed: ${totalIndexed.toLocaleString()} | Errors: ${totalErrors} | ${elapsed}s | ~${rate.toLocaleString()} docs/s\r`
        );
      }

      if (docs.length < opts.batch) break;
      offset += docs.length;
    }
  }

  // Run sub-ranges concurrently
  await Promise.all(subRanges.map(processSubRange));

  // Final flush
  await flushBuffer();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const rate = Math.round(totalPulled / (elapsed || 1));
  console.log(`\n\nDone!`);
  console.log(`  Pulled:  ${totalPulled.toLocaleString()} documents from Meilisearch`);
  console.log(`  Indexed: ${totalIndexed.toLocaleString()} documents into OpenSearch`);
  if (totalErrors > 0) console.log(`  Errors:  ${totalErrors}`);
  console.log(`  Time:    ${elapsed}s (~${rate.toLocaleString()} docs/s)`);

  if (!opts.dryRun) {
    const osCount = await osGetCount();
    console.log(`  OpenSearch "${opts.index}" total docs: ${osCount.toLocaleString()}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Meilisearch → OpenSearch Migration');
  console.log('──────────────────────────────────');
  console.log(`  Meilisearch: ${opts.meiliHost}`);
  console.log(`  OpenSearch:  ${opts.opensearchHost}`);
  console.log(`  Index:       ${opts.index}`);
  console.log('');

  // Verify Meilisearch connectivity
  try {
    const resp = await fetch(`${opts.meiliHost}/health`, {
      headers: { 'Authorization': `Bearer ${opts.meiliKey}` },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    console.log('  Meilisearch: connected ✓');
  } catch (e) {
    console.error(`  Meilisearch: connection failed — ${e.message}`);
    process.exit(1);
  }

  // Verify OpenSearch connectivity (unless count-only)
  if (!opts.count) {
    try {
      const { body } = await osRequest('GET', '/');
      console.log(`  OpenSearch:  connected ✓ (${body.version?.distribution || 'unknown'} ${body.version?.number || ''})`);
    } catch (e) {
      console.error(`  OpenSearch:  connection failed — ${e.message}`);
      process.exit(1);
    }
  }

  // --ensure-index mode
  if (opts.ensureIndex) {
    await osEnsureIndex();
    return;
  }

  // --count mode
  if (opts.count) {
    const start = opts.start ?? 0;
    const end = opts.end ?? 999999999;
    const count = await countDocsInRange(start, end);
    console.log(`\nTotal documents in range ${start.toLocaleString()} - ${end.toLocaleString()}: ${count.toLocaleString()}`);
    return;
  }

  // Migration mode
  await osEnsureIndex();
  await migrateRange(opts.start, opts.end);
}

main().catch((e) => {
  console.error('\nFatal error:', e);
  process.exit(1);
});
