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
 *                      Refused inside any git work tree (this repository or another clone of
 *                      it) and when the file already exists. Written 0600: it holds user-written
 *                      text. Deleted again if the run fails part-way.
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
 *     populate on a cache miss (`setCache` in `blocklist.service.ts`, via `redis.set`). That
 *     method is redirected to a run-local memo that `get` reads first (`suppressCacheWrites`), so a
 *     cold list costs one main-DB read for the whole run and nothing is written to Redis.
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
import { assertDataDirOutsideRepo } from './decision-eval/safety';
import { runScriptAndExit } from './lib/run-as-script';

const SCRIPT_BASENAME = 'replay-shared-data-moderation.ts';

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
    // A following flag is never a value: `--out --page-size 5` must not write a file named `--page-size`.
    const value = argv[i + 1]?.startsWith('--') ? undefined : argv[i + 1];
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

/**
 * The CSV holds user-written text, so it must never land where it could be committed: inside this
 * checkout or any other (another clone of this public repo). `assertDataDirOutsideRepo` is the
 * repo's one rule for that — it resolves links on the real path, walks up looking for `.git` (a
 * linked worktree's `.git` file included) and needs no `git` binary, so it cannot fail open.
 */
export function resolveOutPath(
  out: string,
  exists?: (p: string) => boolean,
  realpath?: (p: string) => string
): string {
  const absolute = path.resolve(out);
  let dir: string;
  try {
    dir = assertDataDirOutsideRepo(path.dirname(absolute), exists, realpath);
  } catch (error) {
    throw new Error(`refusing to write the CSV inside a git checkout: ${absolute}`, {
      cause: error,
    });
  }
  return path.join(dir, path.basename(absolute));
}

/**
 * Both sink clients are built only when these are truthy (the raw value, as their own gates read
 * it); with them empty, neither exists in this process.
 */
export function assertNoSinks(env: Record<string, string | undefined>): void {
  const set = (['CLICKHOUSE_HOST', 'AXIOM_TOKEN'] as const).filter((k) => !!env[k]);
  if (set.length) {
    throw new Error(
      `${set.join(' and ')} must be empty for a replay (set to the empty string, not unset)`
    );
  }
}

/**
 * Turn the cache client's `set` into a write to a RUN-LOCAL memo, and make the client's own `get`
 * read that memo first. See the header: `set` is the one Redis write the scan path can reach.
 *
 * Why a memo rather than a plain no-op: a no-op leaves a cold blocklist key cold, so every later
 * scan would miss again and re-read the main database. With the memo, a key that missed once is
 * served from this process for the rest of the run — one main-DB read per list, no Redis write.
 *
 * 🔴 The overrides sit on the client object, and node-redis derives clients from it by prototype
 * (`withTypeMapping` returns `Object.create(client)` — the Buffer-returning reader behind
 * `redis.packed` is one). So `get` serves the memo ONLY when called on this exact object, and
 * otherwise runs the original method with the caller's own `this`, keeping a derived client's type
 * mapping. A bound original would hand a derived reader strings, and its corrupt-entry eviction would
 * then DELETE live keys. `set` is intercepted for every caller: no path through it may write.
 */
export function suppressCacheWrites(client: object): { memoisedKeys: () => number } {
  const memo = new Map<unknown, unknown>();
  // `object`, not the client's own type: its `get` is a wide overload set no narrower signature
  // matches, and only the call shape `blocklist.service.ts` uses (`get(key)`) matters here.
  const originalGet = (client as { get: (...args: unknown[]) => unknown }).get;
  const define = (name: 'get' | 'set', value: (this: unknown, ...args: unknown[]) => unknown) =>
    Object.defineProperty(client, name, { configurable: true, writable: true, value });
  define('set', async (key, value) => {
    memo.set(key, value);
    return null;
  });
  define('get', function (this: unknown, key, ...rest) {
    if (this === client && memo.has(key)) return Promise.resolve(memo.get(key));
    return originalGet.call(this, key, ...rest);
  });
  return { memoisedKeys: () => memo.size };
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
    // The session sits idle in this transaction while each page is classified; a role-level idle
    // timeout would otherwise kill a long run part-way. Transaction-local, so it ends with it.
    await client.query('SET LOCAL idle_in_transaction_session_timeout = 0');
    const query: Query = async <R>(sql: string, params?: unknown[]) =>
      (await client.query(sql, params)).rows as R[];
    return await fn(query);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/**
 * Create the CSV (exclusively, 0600: it holds user-written text), print its path, and hand `body` a
 * line writer. If anything fails after the file exists — `body`, a write, or the final close (an
 * EIO/ENOSPC flush) — the file is deleted and the ORIGINAL error is rethrown: a partial CSV reads
 * as a finished run. Only the file this call created can be deleted: an existing path fails the
 * exclusive open first. (A signal or OOM kill skips the cleanup; the printed path is how to find
 * what was left.)
 */
export async function withCsvFile<T>(
  out: string,
  body: (write: (line: string) => void) => Promise<T>,
  {
    log = console.log,
    warn = console.error,
    files = fs,
  }: {
    log?: (message: string) => void;
    warn?: (message: string) => void;
    files?: Pick<typeof fs, 'openSync' | 'writeSync' | 'closeSync' | 'rmSync'>;
  } = {}
): Promise<T> {
  const fd = files.openSync(out, 'wx', 0o600);
  log(`writing CSV: ${out}`);
  let open = true;
  try {
    const result = await body((line) => files.writeSync(fd, line));
    open = false;
    files.closeSync(fd);
    return result;
  } catch (error) {
    if (open) {
      try {
        files.closeSync(fd);
      } catch {
        // The original error is the one worth reporting.
      }
    }
    files.rmSync(out, { force: true });
    warn(`run failed; deleted the partial CSV ${out}`);
    throw error;
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

  let hitRows = 0;
  const tallies = await withCsvFile(out, async (write) => {
    write(replay.csvHeader());
    return withReadOnlyTransaction(requireAppsDb(), async (query) => {
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
              write(replay.csvRowLine(row));
              hitRows += 1;
            },
            { pageSize: args.pageSize }
          )
        );
      }
      return results;
    });
  });
  console.log(replay.formatSummary(tallies));
  console.log(
    `blocklist keys that were cold and are held in the run-local memo: ${cacheGuard.memoisedKeys()}`
  );
  console.log(`wrote ${hitRows} hit row(s) to ${out}`);
}

if (process.argv[1]?.endsWith(SCRIPT_BASENAME)) {
  void runScriptAndExit(main);
}
