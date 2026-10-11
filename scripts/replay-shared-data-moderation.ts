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
import { spawnSync } from 'node:child_process';
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

const isInside = (dir: string, root: string) => {
  const relative = path.relative(root, dir);
  return relative === '' || (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..');
};

/** True when `dir` is inside ANY git work tree — another clone of this repo included. */
export function isInGitWorkTree(dir: string): boolean {
  const result = spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
  });
  return result.status === 0 && result.stdout.trim() === 'true';
}

/**
 * The CSV holds user-written text, so it must never land where it could be committed: not inside
 * this checkout, and not inside any other git work tree (another clone of this public repo). The
 * parent directory is resolved through symlinks first, so a link cannot smuggle the file in.
 */
export function resolveOutPath(
  out: string,
  {
    repoRoot = REPO_ROOT,
    inGitWorkTree = isInGitWorkTree,
    realpath = fs.realpathSync,
  }: {
    repoRoot?: string;
    inGitWorkTree?: (dir: string) => boolean;
    realpath?: (p: string) => string;
  } = {}
): string {
  const absolute = path.resolve(out);
  const parent = realpath(path.dirname(absolute));
  const resolved = path.join(parent, path.basename(absolute));
  if (isInside(parent, realpath(repoRoot)) || inGitWorkTree(parent)) {
    throw new Error(`refusing to write the CSV inside a git work tree: ${resolved}`);
  }
  return resolved;
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
 * Turn the cache client's `set` into a write to a RUN-LOCAL memo, and make `get` read that memo
 * first. See the header: `set` is the one Redis write the scan path can reach.
 *
 * Why a memo rather than a plain no-op: a no-op leaves a cold blocklist key cold, so every later
 * scan would miss again and re-read the main database. With the memo, a key that missed once is
 * served from this process for the rest of the run — one main-DB read per list, no Redis write.
 * Only keys this run tried to `set` are intercepted; every other `get` goes to Redis unchanged.
 */
export function suppressCacheWrites(client: object): { suppressed: () => number } {
  const memo = new Map<unknown, unknown>();
  // `object`, not the client's own type: its `get` is a wide overload set no narrower signature
  // matches, and only the call shape `blocklist.service.ts` uses (`get(key)`) matters here.
  const { get } = client as { get: (...args: unknown[]) => unknown };
  const originalGet = get.bind(client);
  const define = (name: 'get' | 'set', value: (...args: unknown[]) => unknown) =>
    Object.defineProperty(client, name, { configurable: true, writable: true, value });
  define('set', async (key, value) => {
    memo.set(key, value);
    return null;
  });
  define('get', (key, ...rest) =>
    memo.has(key) ? Promise.resolve(memo.get(key)) : originalGet(key, ...rest)
  );
  return { suppressed: () => memo.size };
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
  console.log(`writing CSV: ${out}`);
  let hitRows = 0;
  let complete = false;
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
    complete = true;
  } finally {
    fs.closeSync(fd);
    // A partial CSV of user text is worse than none: it reads as a finished run.
    if (!complete) {
      fs.rmSync(out, { force: true });
      console.error(`run failed; deleted the partial CSV ${out}`);
    }
  }
  console.log(`blocklist cache keys served from the run-local memo: ${cacheGuard.suppressed()}`);
  console.log(`wrote ${hitRows} hit row(s) to ${out}`);
}

if (process.argv[1]?.endsWith(SCRIPT_BASENAME)) {
  void runScriptAndExit(main);
}
