#!/usr/bin/env node
/**
 * BitDex Filter Coverage Test Suite
 *
 * Runs a comprehensive set of image search queries covering all filter combinations
 * used across the site. Outputs both markdown (human-readable) and JSON (machine-readable).
 *
 * Usage:
 *   node .claude/skills/bitdex-test/test-filters.mjs [options]
 *
 * Options:
 *   --base-url <url>     Base URL (default: http://localhost:3000)
 *   --section <name>     Run only a specific section (e.g., "main-feed", "model-gallery")
 *   --list               List all available test sections
 *   --limit <n>          Images per query (default: 5)
 *   --output <path>      Write markdown to file (streams as results arrive)
 *   --json-output <path> Write JSON results to file (streams as results arrive)
 *   --concurrency <n>    Parallel requests per section (default: 5)
 *   --verbose            Include full query params in markdown output
 */

import { writeFileSync, appendFileSync } from 'fs';

const BASE_URL = getArg('--base-url') || 'http://localhost:3000';
const LIMIT = parseInt(getArg('--limit') || '5', 10);
const CONCURRENCY = parseInt(getArg('--concurrency') || '5', 10);
const VERBOSE = hasFlag('--verbose');
const OUTPUT_PATH = getArg('--output');
const JSON_OUTPUT_PATH = getArg('--json-output');

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}
function hasFlag(flag) {
  return process.argv.includes(flag);
}

// --- Output helpers ---
function emit(text) {
  if (OUTPUT_PATH) {
    appendFileSync(OUTPUT_PATH, text + '\n');
  }
  process.stdout.write(text + '\n');
}

function initOutput() {
  if (OUTPUT_PATH) writeFileSync(OUTPUT_PATH, '');
  if (JSON_OUTPUT_PATH) writeFileSync(JSON_OUTPUT_PATH, '[\n');
}

// JSON streaming: write each test result as a JSON object in an array.
// We track whether we've written the first entry to handle comma separation.
let jsonFirstEntry = true;
function emitJson(obj) {
  if (!JSON_OUTPUT_PATH) return;
  const prefix = jsonFirstEntry ? '  ' : ', ';
  jsonFirstEntry = false;
  appendFileSync(JSON_OUTPUT_PATH, prefix + JSON.stringify(obj) + '\n');
}

function finalizeJson(summary) {
  if (!JSON_OUTPUT_PATH) return;
  appendFileSync(JSON_OUTPUT_PATH, ']\n');
}

// --- tRPC query helper ---
async function queryImages(input) {
  // Strip undefined values (from spread of FEED_DEFAULTS overrides like types: undefined)
  const clean = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  const payload = {
    json: {
      limit: LIMIT,
      browsingLevel: 31,
      useIndex: true,
      include: ['cosmetics', 'tagIds'],
      ...clean,
    },
  };
  const encoded = encodeURIComponent(JSON.stringify(payload));
  const url = `${BASE_URL}/api/trpc/image.getInfinite?input=${encoded}`;

  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    const elapsed = Date.now() - start;

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { query: payload.json, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, elapsed };
    }

    const data = await res.json();
    const result = data.result?.data?.json ?? data;
    return { query: payload.json, items: result.items || [], nextCursor: result.nextCursor, elapsed };
  } catch (err) {
    return { query: payload.json, error: err.message, elapsed: Date.now() - start };
  }
}

// --- Compact image summary ---
function summarizeImage(img) {
  const date = img.createdAt || img.sortAt;
  const dateStr = date ? new Date(date).toISOString().slice(0, 10) : '?';
  const user = img.user?.username || `uid:${img.userId}`;
  const rxn = img.stats
    ? `❤${img.stats.heartCountAllTime}+👍${img.stats.likeCountAllTime}+😂${img.stats.laughCountAllTime}`
    : `rxn:${img.reactionCount ?? 0}`;

  const flags = [
    img.blockedFor ? `BLOCKED:${img.blockedFor}` : '',
    img.poi ? 'POI' : '',
    img.minor ? 'MINOR' : '',
    img.remixOfId ? `remix:${img.remixOfId}` : '',
    !img.publishedAt ? 'UNPUB' : '',
  ].filter(Boolean).join(' ');

  return `id:${img.id} ${img.type || '?'} nsfw:${img.nsfwLevel} ${img.availability || '?'} ${user} ${dateStr} ${img.baseModel || '-'} ${rxn}${flags ? ' ' + flags : ''}`;
}

// --- Compact image for JSON output ---
function imageToJson(img) {
  return {
    id: img.id,
    type: img.type,
    nsfwLevel: img.nsfwLevel,
    availability: img.availability,
    user: img.user?.username || img.userId,
    date: (img.createdAt || img.sortAt || '').toString().slice(0, 10),
    baseModel: img.baseModel || null,
    reactionCount: img.stats?.heartCountAllTime ?? img.reactionCount ?? 0,
    commentCount: img.stats?.commentCountAllTime ?? img.commentCount ?? 0,
    collectedCount: img.stats?.collectedCountAllTime ?? img.collectedCount ?? 0,
    tagIds: img.tagIds?.slice(0, 5),
    blockedFor: img.blockedFor || null,
    remixOfId: img.remixOfId || null,
    hasMeta: img.hasMeta,
    onSite: img.onSite,
  };
}

// --- Run a single test and emit results immediately ---
async function runTest(name, section, input) {
  const result = await queryImages(input);

  if (result.error) {
    emit(`### ❌ ${name}`);
    emit(`**Error**: ${result.error} (${result.elapsed}ms)`);
    if (VERBOSE) emit(`\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``);
    emit('');

    emitJson({
      test: name,
      section,
      status: 'error',
      error: result.error,
      elapsed: result.elapsed,
      query: result.query,
    });

    return { pass: false };
  }

  const count = result.items.length;
  const hasMore = !!result.nextCursor;
  emit(`### ✅ ${name}`);
  emit(`**${count} results** | ${result.elapsed}ms${hasMore ? ' | more pages' : ' | end'}`);
  if (VERBOSE) emit(`\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``);

  if (count > 0) {
    emit('```');
    for (const img of result.items) {
      emit(summarizeImage(img));
    }
    emit('```');
  }
  emit('');

  emitJson({
    test: name,
    section,
    status: 'ok',
    elapsed: result.elapsed,
    count,
    hasMore,
    query: result.query,
    items: result.items.map(imageToJson),
  });

  return { pass: true, count };
}

// --- Run tests in parallel batches ---
async function runBatch(sectionKey, tests) {
  const results = [];
  for (let i = 0; i < tests.length; i += CONCURRENCY) {
    const batch = tests.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(([name, input]) => runTest(name, sectionKey, input))
    );
    results.push(...batchResults);
  }
  return results;
}

// --- Frontend defaults ---
// The frontend (FiltersProvider + useQueryImages) injects these by default on /images:
//   sort: 'Most Reactions', period: 'Week', types: ['image'], browsingLevel: 1
// We use browsingLevel: 31 (all) to avoid false negatives from NSFW filtering.
// Each test overrides specific fields to isolate what it's testing.
const FEED_DEFAULTS = { sort: 'Most Reactions', period: 'Week', types: ['image'] };

// --- Test sections ---
const sections = {
  'main-feed': {
    label: 'Main Image Feed (/images)',
    description: 'The primary image gallery page with all available filters. Uses frontend defaults: sort=Most Reactions, period=Week, types=[image].',
    tests: [
      // Sort variations (keep period/types from defaults)
      ['Default feed (Most Reactions + Week + image)', { ...FEED_DEFAULTS }],
      ['Sort: Newest', { ...FEED_DEFAULTS, sort: 'Newest' }],
      ['Sort: Most Comments', { ...FEED_DEFAULTS, sort: 'Most Comments' }],
      ['Sort: Most Collected', { ...FEED_DEFAULTS, sort: 'Most Collected' }],
      ['Sort: Oldest', { ...FEED_DEFAULTS, sort: 'Oldest', period: 'AllTime' }],

      // Period variations
      ['Period: Day', { ...FEED_DEFAULTS, period: 'Day' }],
      ['Period: Month', { ...FEED_DEFAULTS, period: 'Month' }],
      ['Period: Year', { ...FEED_DEFAULTS, period: 'Year' }],
      ['Period: AllTime', { ...FEED_DEFAULTS, period: 'AllTime' }],

      // Type variations (user switches type selector)
      ['Type: all (no type filter)', { ...FEED_DEFAULTS, types: undefined }],
      ['Type: video only', { ...FEED_DEFAULTS, types: ['video'] }],

      // Boolean filters (additive to defaults)
      ['With metadata only', { ...FEED_DEFAULTS, withMeta: true }],
      ['From platform only', { ...FEED_DEFAULTS, fromPlatform: true }],
      ['Remixes only', { ...FEED_DEFAULTS, remixesOnly: true }],
      ['Originals only (non-remixes)', { ...FEED_DEFAULTS, nonRemixesOnly: true }],

      // NSFW browsing level (overrides the default browsingLevel:31 from queryImages)
      ['NSFW: PG only (level 1)', { ...FEED_DEFAULTS, browsingLevel: 1 }],
      ['NSFW: PG+PG13 (level 3)', { ...FEED_DEFAULTS, browsingLevel: 3 }],
      ['NSFW: R+ (level 28)', { ...FEED_DEFAULTS, browsingLevel: 28 }],

      // Base model filters
      ['Base model: SD 1.5', { ...FEED_DEFAULTS, baseModels: ['SD 1.5'] }],
      ['Base model: SDXL 1.0', { ...FEED_DEFAULTS, baseModels: ['SDXL 1.0'] }],
      ['Base model: Pony', { ...FEED_DEFAULTS, baseModels: ['Pony'] }],
      ['Base model: Flux.1 D', { ...FEED_DEFAULTS, baseModels: ['Flux.1 D'] }],
      ['Base model: multiple', { ...FEED_DEFAULTS, baseModels: ['SD 1.5', 'SDXL 1.0', 'Pony'] }],

      // Combined filters (realistic user combos)
      ['Combined: Newest + AllTime + image + meta', { sort: 'Newest', period: 'AllTime', types: ['image'], withMeta: true }],
      ['Combined: Most Reactions + Month + video + platform', { sort: 'Most Reactions', period: 'Month', types: ['video'], fromPlatform: true }],
    ],
  },

  'user-profile': {
    label: 'User Profile Images Tab',
    description: "Viewing a specific user's uploaded images. Profile uses sort=Newest, period=AllTime, no type filter.",
    tests: [
      ['User images (newest)', { username: 'civitai', sort: 'Newest', period: 'AllTime' }],
      ['User images (most reactions)', { username: 'civitai', sort: 'Most Reactions', period: 'AllTime' }],
      ['User images only', { username: 'civitai', sort: 'Newest', period: 'AllTime', types: ['image'] }],
      ['User videos only', { username: 'civitai', sort: 'Newest', period: 'AllTime', types: ['video'] }],
      ['User images with meta', { username: 'civitai', sort: 'Newest', period: 'AllTime', withMeta: true }],
    ],
  },

  'model-gallery': {
    label: 'Model Version Gallery',
    description: 'Image gallery on a model page filtered to a specific model version. Uses sort=Most Reactions, period=AllTime.',
    tests: [
      ['Model gallery (placeholder mvId:1)', { modelVersionId: 1, sort: 'Most Reactions', period: 'AllTime' }],
    ],
  },

  'post-detail': {
    label: 'Post Detail Page',
    description: 'Images within a specific post',
    tests: [
      ['Post images (placeholder postId:1)', { postId: 1, sort: 'Newest' }],
    ],
  },

  'remix-detail': {
    label: 'Image Remix Detail',
    description: 'Viewing remixes of a specific image',
    tests: [
      ['Remixes of image (placeholder id:1)', { remixOfId: 1, sort: 'Newest' }],
    ],
  },

  'edge-cases': {
    label: 'Edge Cases & Boundary Tests',
    description: 'Tests for uncommon filter states and potential issues',
    tests: [
      ['Empty result (impossible combo)', { ...FEED_DEFAULTS, tags: [999999999] }],
      ['Limit 1', { ...FEED_DEFAULTS, limit: 1 }],
      ['Limit 200 (max)', { ...FEED_DEFAULTS, limit: 200 }],
      ['Multiple tags (likely empty)', { ...FEED_DEFAULTS, tags: [1, 2, 3] }],
      ['Excluded tags', { ...FEED_DEFAULTS, excludedTagIds: [1] }],
      ['No filters at all (bare minimum)', { sort: 'Newest' }],
    ],
  },
};

// --- Main ---
async function main() {
  if (hasFlag('--list')) {
    console.log('\nAvailable test sections:\n');
    for (const [key, section] of Object.entries(sections)) {
      console.log(`  ${key.padEnd(20)} ${section.label} (${section.tests.length} tests)`);
    }
    console.log(`\nUsage: node test-filters.mjs --section <name>\n       node test-filters.mjs          (runs all)\n`);
    return;
  }

  const sectionFilter = getArg('--section');
  const sectionsToRun = sectionFilter
    ? { [sectionFilter]: sections[sectionFilter] }
    : sections;

  if (sectionFilter && !sections[sectionFilter]) {
    console.error(`Unknown section: ${sectionFilter}. Use --list to see available sections.`);
    process.exit(1);
  }

  initOutput();

  let totalTests = 0;
  let totalPassed = 0;
  let totalFailed = 0;

  emit('# BitDex Filter Coverage Test Results');
  emit(`> Generated: ${new Date().toISOString()}`);
  emit(`> Base URL: ${BASE_URL} | Limit: ${LIMIT} | Concurrency: ${CONCURRENCY}`);
  emit('');

  for (const [key, section] of Object.entries(sectionsToRun)) {
    emit(`## ${section.label}`);
    emit(`_${section.description}_\n`);

    const results = await runBatch(key, section.tests);
    for (const r of results) {
      totalTests++;
      if (r.pass) totalPassed++;
      else totalFailed++;
    }
  }

  emit('---');
  emit('## Summary');
  emit(`| Metric | Value |`);
  emit(`|--------|-------|`);
  emit(`| Total tests | ${totalTests} |`);
  emit(`| Passed | ${totalPassed} |`);
  emit(`| Failed | ${totalFailed} |`);
  emit('');

  finalizeJson();

  if (OUTPUT_PATH) console.log(`\nMarkdown report: ${OUTPUT_PATH}`);
  if (JSON_OUTPUT_PATH) console.log(`JSON report: ${JSON_OUTPUT_PATH}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
