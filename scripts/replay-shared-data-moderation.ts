/**
 * Offline replay of App Blocks shared-data moderation over EXISTING stored content.
 *
 * The live scans (`shared-data-moderation.ts`, behind `app-blocks-shared-data-moderation` and
 * `app-blocks-shared-data-moderation-enforce`) only see NEW writes: a `data` blob when it is
 * appended or updated, a counter key only on the increment that creates it. Content stored before
 * either flag was on is never re-checked. This script runs every stored `data` blob and every
 * counter key through the same classification, with SHADOW semantics: it records what WOULD be
 * blocked, into a local CSV. That covers the content the live scans never recheck, which is the
 * coverage precondition for the enforce flag. It is not a false-positive-rate measurement: the
 * stored corpus is too small for that.
 *
 * Usage:
 *   CLICKHOUSE_HOST= AXIOM_TOKEN= pnpm run tsscript scripts/replay-shared-data-moderation.ts [options]
 *
 * Options:
 *   --out <path>       CSV to write. Default: <os tmpdir>/civitai-shared-data-replay/
 *                      shared-data-replay-<timestamp>.csv. Refused inside any git work tree (this
 *                      repository or another clone of it) and when the file already exists.
 *                      Written 0600: it holds user-written text. Deleted again if the run fails
 *                      part-way.
 *   --page-size <n>    Rows per keyset page (default 500).
 *
 * Environment (the app's server env, loaded the usual `tsscript` way):
 *   APPS_DATABASE_URL  The App Blocks storage database. Required; read inside one REPEATABLE READ,
 *                      READ ONLY transaction, so the database refuses any write. That transaction
 *                      sets `idle_in_transaction_session_timeout` to 4 hours
 *                      (`IDLE_IN_TRANSACTION_TIMEOUT_MS`): an idle gap longer than that between two
 *                      statements (e.g. a hung Redis read) ends the run instead of pinning the
 *                      snapshot, which would hold back vacuum in every app schema.
 *   REDIS_URL (+ the rest of the app's Redis env)  The cache the blocklists are read from (and,
 *                      on a miss, written back to — see below).
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
 *     `scheduleSharedDataShadow`), and the two sink clients are absent by the env check above.
 *
 * What it CAN write:
 *   - a blocklist's cache key in Redis, on a cache miss (one key per list read: link domains,
 *     message patterns, benign phrases). Reading a cold list runs the ordinary cache-aside populate
 *     in `blocklist.service.ts` (`setCache`, 5-minute TTL), exactly as every production pod does on
 *     a miss. That populate is the one Redis write the scan path reaches.
 *   - the CSV, and deletions of expired CSVs in the dedicated directory (retention, below).
 *
 * Retention: the CSV holds production user text, which expires 30 days after it is written (the
 * same window as the live hit table). Every run first deletes any `*.csv` older than 30 days (by
 * mtime) in the dedicated directory `<os tmpdir>/civitai-shared-data-replay/` and prints what it
 * deleted; it touches nothing outside that directory. So an expired CSV there is deleted by the NEXT
 * run, not on the day it expires: each run prints the expiry date and the `rm` command to use if no
 * further run is coming. A CSV written elsewhere with `--out` is never swept, and the script says so
 * and by when to delete it by hand.
 *
 * Reading the numbers — `userChosenCounter` (CSV) and the summary's user-chosen figures: a counter
 * key counts as user-chosen when its anchor row is still `{}` OR the key is not ULID-shaped (every
 * append key is a server ULID). An app-chosen key that is ULID-shaped AND whose anchor row the author
 * later edited reads as NOT user-chosen, so those figures can undercount by exactly such keys. Every
 * counter key is still scanned and appears in the overall counter tally and the CSV. The summary
 * prints this note too.
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

/** Where the default CSV goes, and the only directory the retention sweep ever touches. */
export const REPLAY_DIR_NAME = 'civitai-shared-data-replay';
export const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

export const defaultReplayDir = (tmp: string = os.tmpdir()) => path.join(tmp, REPLAY_DIR_NAME);

/**
 * Create the dedicated directory 0700 (or tighten an existing one to 0700) and return its real path.
 * A symlink or a non-directory in its place is refused: the sweep deletes files in whatever this
 * resolves to.
 */
export function ensureReplayDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`refusing to use ${dir}: not a plain directory`);
  }
  fs.chmodSync(dir, 0o700);
  return fs.realpathSync(dir);
}

/**
 * Delete every regular `*.csv` file directly in `dir` whose mtime is more than `RETENTION_DAYS`
 * before `now`, logging each, and return what was deleted. Never recurses, never follows a symlink,
 * never touches another extension or anything outside `dir`.
 */
export function sweepExpiredCsvs(
  dir: string,
  now: Date,
  log: (message: string) => void = console.log
): string[] {
  const deleted: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.csv')) continue;
    const file = path.join(dir, entry.name);
    if (now.getTime() - fs.lstatSync(file).mtimeMs <= RETENTION_MS) continue;
    fs.rmSync(file);
    deleted.push(file);
    log(`retention: deleted expired CSV (older than ${RETENTION_DAYS} days): ${file}`);
  }
  if (!deleted.length) log(`retention: no CSV older than ${RETENTION_DAYS} days in ${dir}`);
  return deleted;
}

/**
 * What the operator is told once a CSV exists: where it is, when it expires, how to delete it
 * sooner, and — when it lies outside the swept directory — that nothing will delete it for them.
 */
export function retentionNotice(out: string, replayDir: string, now: Date): string[] {
  const expires = new Date(now.getTime() + RETENTION_MS).toISOString().slice(0, 10);
  const quoted = `'${out.replace(/'/g, `'\\''`)}'`;
  const lines = [
    `CSV: ${out}`,
    `expires: ${expires} (UTC, ${RETENTION_DAYS} days)`,
    `delete it sooner: rm -- ${quoted}`,
  ];
  if (path.dirname(out) !== replayDir) {
    lines.push(
      `WARNING: this file is NOT in ${replayDir} and is NOT covered by the automatic ` +
        `${RETENTION_DAYS}-day sweep. Delete it by hand by ${expires}.`
    );
  }
  return lines;
}

export interface ReplayArgs {
  out: string;
  pageSize: number;
}

export function parseArgs(argv: string[], now: Date = new Date()): ReplayArgs {
  const args: ReplayArgs = {
    out: path.join(
      defaultReplayDir(),
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

interface ReadOnlyPool {
  connect(): Promise<{
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
    release(): void;
  }>;
}

/**
 * The longest the session may sit idle inside the replay transaction between two statements. Finite
 * so a hung Redis read cannot hold the snapshot (and so vacuum, across every app schema) open forever.
 */
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 4 * 60 * 60 * 1000;

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
    // The session sits idle in this transaction while each page is classified; a short role-level
    // idle timeout could kill the run part-way. The bound applies to each idle gap, not the whole
    // run. Plain integer = milliseconds. Transaction-local, so it ends with the transaction.
    await client.query(
      `SET LOCAL idle_in_transaction_session_timeout = ${IDLE_IN_TRANSACTION_TIMEOUT_MS}`
    );
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
  const now = new Date();
  const args = parseArgs(process.argv.slice(2), now);
  const replayDir = ensureReplayDir(defaultReplayDir());
  sweepExpiredCsvs(replayDir, now);
  const out = resolveOutPath(args.out);

  // Loads `.env` (under tsscript's NODE_ENV=development) and validates it. ORDER MATTERS: the sink
  // check reads the loaded env, and the modules imported below reach the ClickHouse/Axiom clients.
  await import('~/env/server');
  assertNoSinks(process.env);

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
    for (const line of retentionNotice(out, replayDir, now)) console.log(line);
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
  console.log(`wrote ${hitRows} hit row(s) to ${out}`);
  for (const line of retentionNotice(out, replayDir, now)) console.log(line);
}

if (process.argv[1]?.endsWith(SCRIPT_BASENAME)) {
  void runScriptAndExit(main);
}
