/**
 * Offline replay of App Blocks shared-data moderation over EXISTING stored content.
 *
 * The live scans (`shared-data-moderation.ts`, behind `app-blocks-shared-data-moderation` and
 * `app-blocks-shared-data-moderation-enforce`) only see NEW writes: a `data` blob when it is
 * appended or updated, a counter key only on the increment that creates it. Content stored before
 * either flag was on is never re-checked. This script runs every stored `data` blob and every
 * counter key through the same classification, with SHADOW semantics: it records what WOULD be
 * blocked, into a local CSV, and does nothing else. Its output is the measured false-positive
 * rate over existing content that the enforce flip depends on.
 *
 * Usage:
 *   CLICKHOUSE_HOST= AXIOM_TOKEN= pnpm run tsscript scripts/replay-shared-data-moderation.ts [options]
 *
 * Options:
 *   --out <path>       CSV to write. Default: <os tmpdir>/shared-data-replay-<timestamp>.csv.
 *                      Refused when it is inside this repository or already exists. Written 0600:
 *                      it holds user-written text.
 *   --page-size <n>    Rows per keyset page (default 500).
 *
 * Environment (the app's server env, loaded the usual `tsscript` way):
 *   APPS_DATABASE_URL  The App Blocks storage database. Required; read inside a READ ONLY
 *                      transaction, so the database refuses any write.
 *   REDIS_URL (+ the rest of the app's Redis env)  The cache the blocklists are read from.
 *   DATABASE_URL       The main database: a blocklist read falls back to it when its cache key is
 *                      cold (one SELECT on the Blocklist table).
 *   CLICKHOUSE_HOST, AXIOM_TOKEN  Must be EMPTY. The script refuses to start otherwise, so neither
 *                      client can exist in this process. (Set them to the empty string: under
 *                      `tsscript` an unset variable is filled in from `.env`, an empty one is not.)
 *
 * What it never does:
 *   - write to the storage database (READ ONLY transaction, SELECT only);
 *   - insert into ClickHouse, emit to Axiom, file a Report, alert, or count toward a mute — it never
 *     calls the recording half of `shared-data-moderation.ts` (`recordSharedDataScan`,
 *     `scheduleSharedDataShadow`), and the two sink clients are absent by the env check above;
 *   - write to Redis. The one Redis write reachable from the scan path is the blocklist cache
 *     populate on a cache miss (`setCache` in `blocklist.service.ts`, via `redis.set`). That method
 *     is replaced on the cache client with a no-op that counts the suppressed writes, which the
 *     summary prints. A cold cache therefore costs main-DB reads on each scan rather than a write.
 *
 * Detectors that need I/O: only the blocklist-backed two (link domains, message patterns) and the
 * benign-phrase list the audit strips first. Every other detector is code bundled in the app. Before
 * scanning, the script requires both blocklists to be non-empty and proves each catches a probe
 * built from its own live entries — an unreadable list fails the run instead of reading as zero.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppSchemaRow, Query } from './shared-data-replay/replay';
import { runScriptAndExit } from './lib/run-as-script';

const SCRIPT_BASENAME = 'replay-shared-data-moderation.ts';
const REPO_ROOT = path.resolve(__dirname, '..');

export interface ReplayArgs {
  out: string;
  pageSize: number;
}

export function parseArgs(argv: string[], now: Date = new Date()): ReplayArgs {
  const args: ReplayArgs = {
    out: path.join(
      os.tmpdir(),
      `shared-data-replay-${now.toISOString().replace(/[:.]/g, '-')}.csv`
    ),
    pageSize: 500,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--out' && value) {
      args.out = value;
      i++;
    } else if (flag === '--page-size' && value) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--page-size must be a positive integer`);
      args.pageSize = n;
      i++;
    } else {
      throw new Error(`unknown or incomplete argument: ${flag}`);
    }
  }
  return args;
}

/** The CSV holds user-written text: never inside the repository, where it could be committed. */
export function resolveOutPath(out: string, repoRoot: string = REPO_ROOT): string {
  const resolved = path.resolve(out);
  const relative = path.relative(path.resolve(repoRoot), resolved);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    throw new Error(`refusing to write the CSV inside the repository: ${resolved}`);
  }
  return resolved;
}

/** Both sink clients are built only from these; with them empty, neither exists in this process. */
export function assertNoSinks(env: Record<string, string | undefined>): void {
  const set = (['CLICKHOUSE_HOST', 'AXIOM_TOKEN'] as const).filter((k) => env[k]?.trim());
  if (set.length) {
    throw new Error(
      `${set.join(' and ')} must be empty for a replay (set to the empty string, not unset)`
    );
  }
}

/**
 * Replace the cache client's `set` with a no-op that counts. See the header: it is the one Redis
 * write the scan path can reach.
 */
export function suppressCacheWrites(client: object): { suppressed: () => number } {
  let suppressed = 0;
  Object.defineProperty(client, 'set', {
    configurable: true,
    writable: true,
    value: async () => {
      suppressed += 1;
      return null;
    },
  });
  return { suppressed: () => suppressed };
}

interface ReadOnlyPool {
  connect(): Promise<{
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
    release(): void;
  }>;
}

/**
 * Run `fn` inside one REPEATABLE READ, READ ONLY transaction (one consistent snapshot, and the
 * database rejects any write), always ending in ROLLBACK.
 */
export async function withReadOnlyTransaction<T>(
  pool: ReadOnlyPool,
  fn: (query: Query) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const query: Query = async <R>(sql: string, params?: unknown[]) =>
      (await client.query(sql, params)).rows as R[];
    return await fn(query);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = resolveOutPath(args.out);

  // Loads `.env` (under tsscript's NODE_ENV=development) and validates it. Nothing that opens a
  // client is imported until the sink check has passed.
  await import('~/env/server');
  assertNoSinks(process.env);

  const { redis } = await import('~/server/redis/client');
  const cacheGuard = suppressCacheWrites(redis);
  const { getBlocklistData } = await import('~/server/services/blocklist.service');
  const { BlocklistType } = await import('~/server/common/enums');
  const { requireAppsDb } = await import('~/server/db/appsDb');
  const replay = await import('./shared-data-replay/replay');

  const [linkDomains, messagePatterns, benignPhrases] = await Promise.all([
    getBlocklistData(BlocklistType.LinkDomain),
    getBlocklistData(BlocklistType.MessagePattern),
    getBlocklistData(BlocklistType.PromptBenignPhrase),
  ]);
  console.log(
    `blocklists: LinkDomain=${linkDomains.length} MessagePattern=${messagePatterns.length} ` +
      `PromptBenignPhrase=${benignPhrases.length}`
  );
  await replay.blocklistSelfCheck({ linkDomains, messagePatterns });
  console.log('self-check: link and pattern detectors both caught their probe');

  const fd = fs.openSync(out, 'wx', 0o600);
  let hitRows = 0;
  try {
    fs.writeSync(fd, replay.csvHeader());
    const tallies = await withReadOnlyTransaction(requireAppsDb(), async (query) => {
      const selection = replay.selectAppSchemas(
        await query<AppSchemaRow>(replay.LIST_APP_SCHEMAS_SQL)
      );
      console.log(
        `schemas: ${selection.apps.length} with shared tables, ` +
          `${selection.withoutSharedTables.length} without, ${selection.rejected.length} rejected`
      );
      for (const name of selection.rejected) {
        console.warn(`WARNING: not scanned, name is not a provisioned app schema: ${name}`);
      }
      const results = [];
      for (const app of selection.apps) {
        results.push(
          await replay.replayApp(
            query,
            app,
            (row) => {
              fs.writeSync(fd, replay.csvRowLine(row));
              hitRows += 1;
            },
            { pageSize: args.pageSize }
          )
        );
      }
      return results;
    });
    console.log(replay.formatSummary(tallies));
  } finally {
    fs.closeSync(fd);
  }
  console.log(`blocklist cache writes suppressed: ${cacheGuard.suppressed()}`);
  console.log(`wrote ${hitRows} hit row(s) to ${out}`);
}

if (process.argv[1]?.endsWith(SCRIPT_BASENAME)) {
  void runScriptAndExit(main);
}
