// Generates metrics/populate.json: what Node's image-metrics miss path does, recorded from the REAL
// Node code (see README.md "metrics").
//
//   TZ=UTC node --import tsx apps/feed-go/testdata/golden/gen-metrics.mjs
//
// (run from a clone with `pnpm install` done and the event-engine-common submodule checked out).
//
// Each case runs `MetricService.fetch('Image', ids)` (event-engine-common/services/metrics.ts, imported
// as is through tsx) over two recording fakes and writes what it did:
//   - the ClickHouse client records every query MetricService sends (the SQL text and its
//     per-query settings) and answers it with the case's rows (as JSONEachRow with
//     output_format_json_quote_64bit_integers=0 hands them to Node: numbers), or throws the case's
//     error (a server-side TIMEOUT_EXCEEDED carries `code: '159'`, as @clickhouse/client reports it);
//   - the Redis client is an in-memory store that runs the commands MetricService sends. The two
//     Lua scripts are EVAL'd (no SCRIPT LOAD answer, so evalSha is never used): the store executes
//     them by their text, and records each script's text so feed-go can send the same one.
// Recorded per case: the queries, the result fetch returned (or the error it threw), the store
// before and after (every key, its value or hash, and its expiry), and the script texts.
//
// The clock is fixed (Date.now) so the `_populatedAt` stamps are literal. Everything is SYNTHETIC
// (image ids 8001.., 9001..).
process.env.TZ = 'UTC';

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const NOW_MS = Date.UTC(2026, 10, 16, 12, 0, 0);
Date.now = () => NOW_MS;

const { MetricService } = await import(
  pathToFileURL(join(REPO, 'event-engine-common', 'services', 'metrics.ts')).href
);

// The final query text @clickhouse/client sends for a JSONEachRow query (formatQuery in
// @clickhouse/client dist/common/client.js: trim, drop trailing semicolons, append the format).
function formatQuery(query) {
  query = query.trim();
  let end = query.length;
  while (end > 0 && query[end - 1] === ';') end--;
  return query.slice(0, end) + ' \nFORMAT JSONEachRow';
}

function makeStore(initial) {
  const strings = new Map();
  const hashes = new Map();
  const ttls = new Map();
  for (const [k, v] of Object.entries(initial.strings ?? {})) {
    strings.set(k, v.value);
    if (v.ttl) ttls.set(k, v.ttl);
  }
  for (const [k, v] of Object.entries(initial.hashes ?? {})) {
    hashes.set(k, { ...v.fields });
    if (v.ttl) ttls.set(k, v.ttl);
  }
  const exists = (k) => strings.has(k) || hashes.has(k);
  const del = (k) => {
    const had = exists(k);
    strings.delete(k);
    hashes.delete(k);
    ttls.delete(k);
    return had ? 1 : 0;
  };
  const scripts = {};
  const client = {
    async hGetAll(k) {
      return { ...(hashes.get(k) ?? {}) };
    },
    async get(k) {
      return strings.has(k) ? strings.get(k) : null;
    },
    async set(k, v, opts) {
      strings.set(k, v);
      if (opts?.EX) ttls.set(k, opts.EX);
      else ttls.delete(k);
      return 'OK';
    },
    async del(k) {
      return del(k);
    },
    async expire(k, s) {
      if (!exists(k)) return 0;
      ttls.set(k, s);
      return 1;
    },
    async sendCommand() {
      return undefined;
    },
    async eval(script, { keys, arguments: args }) {
      if (script.includes("'NX', 'KEEPTTL'")) {
        scripts.nxWithTtl = script;
        if (exists(keys[0])) return 0;
        strings.set(keys[0], args[0]);
        ttls.set(keys[0], Number(args[1]));
        return 1;
      }
      if (script.includes("redis.call('DEL', KEYS[1])") && script.includes('ARGV[4]')) {
        scripts.hReplaceStampedEx = script;
        del(keys[0]);
        const stamp = exists(keys[1]) ? args[3] : args[2];
        const fields = { [args[1]]: stamp };
        for (let i = 4; i < args.length; i += 2) fields[args[i]] = args[i + 1];
        hashes.set(keys[0], fields);
        ttls.set(keys[0], Number(args[0]));
        return 1;
      }
      throw new Error('unknown script: ' + script);
    },
  };
  const dump = () => {
    const out = { strings: {}, hashes: {} };
    for (const k of [...strings.keys()].sort()) out.strings[k] = { value: strings.get(k), ttl: ttls.get(k) ?? 0 };
    for (const k of [...hashes.keys()].sort()) out.hashes[k] = { fields: hashes.get(k), ttl: ttls.get(k) ?? 0 };
    return out;
  };
  return { client, dump, scripts, hashes };
}

const range = (from, n) => Array.from({ length: n }, (_, i) => from + i);
const metricRow = (entityId, metricType, value) => ({ entityId, metricType, value });

const cases = [
  {
    name: 'cold',
    about:
      'three cold images (one requested twice): two with rows, one with none (a notFound marker, 5 min); image 8002 has a recent-event marker, so its stamp is aged',
    ids: [8001, 8002, 8003, 8001],
    store: { strings: { '{metrics:Image:8002}:recent': { value: '1', ttl: 900 } } },
    rows: [
      metricRow(8001, 'Like', 5),
      metricRow(8001, 'Heart', 2),
      metricRow(8001, 'Laugh', 4),
      metricRow(8001, 'Cry', 1),
      metricRow(8001, 'commentCount', 3),
      metricRow(8001, 'Collection', 7),
      metricRow(8001, 'tippedAmount', 100),
      metricRow(8001, 'tippedCount', 2),
      metricRow(8002, 'Like', 1),
    ],
  },
  {
    name: 'timeout-marker',
    about: 'an image a capped lookup was stopped for: the lookup runs with the retry settings (no cap)',
    ids: [8004],
    store: { strings: { 'metrics:timeout:Image:8004': { value: '1', ttl: 43200 } } },
    rows: [metricRow(8004, 'Heart', 6)],
  },
  {
    name: 'server-timeout',
    about:
      'the server stops the capped lookup (code 159): the ids are marked for an uncapped retry, the locks are left to expire, and fetch throws',
    ids: [8005, 8006],
    store: {},
    error: { message: 'Timeout exceeded: elapsed 6.0 seconds, maximum: 6', code: '159' },
  },
  {
    name: 'other-error',
    about: 'any other ClickHouse error: the locks are released, nothing is marked, fetch throws',
    ids: [8009],
    store: {},
    error: { message: 'Too many simultaneous queries', code: '202' },
  },
  {
    name: 'large',
    about: 'more than 100 ids: the server defaults (no per-query settings)',
    ids: range(9001, 101),
    store: {},
    rows: [metricRow(9001, 'Like', 1), metricRow(9101, 'commentCount', 2)],
  },
  {
    name: 'locked-filled',
    about:
      "image 8008's populate lock is held elsewhere: fetch waits on the cache and takes the holder's hash; 8007 is looked up",
    ids: [8007, 8008],
    store: { strings: { 'metrics:lock:Image:8008': { value: '1', ttl: 10 } } },
    rows: [metricRow(8007, 'Cry', 2)],
    fillLater: { key: 'metrics:Image:8008', fields: { Like: '9', _populatedAt: String(Math.floor(NOW_MS / 1000) - 5) } },
  },
  {
    name: 'locked-never-filled',
    about: "image 8010's lock is held and its holder never fills the cache: after the retries it is all zeros",
    ids: [8010],
    store: { strings: { 'metrics:lock:Image:8010': { value: '1', ttl: 10 } } },
    rows: [],
  },
];

const out = { generatedBy: 'gen-metrics.mjs', nowMs: NOW_MS, scripts: {}, cases: [] };
for (const c of cases) {
  const store = makeStore(c.store);
  const before = store.dump();
  const queries = [];
  const ch = {
    async query({ query, format, clickhouse_settings }) {
      queries.push({ query, wire: formatQuery(query), format, settings: clickhouse_settings ?? null });
      if (c.error) {
        const e = new Error(c.error.message);
        e.code = c.error.code;
        throw e;
      }
      if (c.fillLater) {
        // The other holder fills its id while this lookup runs.
        store.hashes.set(c.fillLater.key, { ...c.fillLater.fields });
      }
      return { json: async () => c.rows, text: async () => '', stream: () => null };
    },
  };
  if (c.fillLater && !c.rows.length) throw new Error('fillLater needs a lookup');
  const svc = new MetricService(ch, store.client);
  let result = null;
  let error = null;
  try {
    result = await svc.fetch('Image', c.ids);
  } catch (e) {
    error = { message: e.message, code: e.code ?? null };
  }
  Object.assign(out.scripts, store.scripts);
  out.cases.push({
    name: c.name,
    about: c.about,
    ids: c.ids,
    rows: c.rows ?? null,
    chError: c.error ?? null,
    // A hash another process writes while this case's lookup runs (its holder's populate).
    fillLater: c.fillLater ?? null,
    queries,
    result,
    error,
    before,
    after: store.dump(),
  });
}

mkdirSync(join(HERE, 'metrics'), { recursive: true });
writeFileSync(join(HERE, 'metrics', 'populate.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${out.cases.length} cases`);
