/**
 * Serialised unit-test runs.
 *
 * The daemon owns the run, not the caller. That is the whole point: an agent that dies mid-wait
 * releases nothing, because it was never holding anything. A slot is held while a run is TRACKED
 * and released when the child process exits — never on a status field, which is a report rather
 * than an observation (a grandchild can outlive a kill; on Windows the tracked process is the
 * shell, not vitest).
 *
 * Timer-free by design. `sweep()` is called by the daemon, so every deadline in here is driven by
 * the injected clock and a test can advance it without waiting.
 */

import { EventEmitter } from 'events';
import { spawn, execFileSync } from 'child_process';
import { closeSync, existsSync, openSync, readSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { StringDecoder } from 'string_decoder';

/**
 * How much the tail reads at a time.
 *
 * Exported because two tests pin behaviour AT this boundary — a line and a multi-byte character
 * straddling it — and a private copy of the number in the test file means widening the window
 * here makes both of those controls vacuous while they stay green. Measured: at 128 KiB with a
 * hand-copied constant, the whole suite passed with the StringDecoder deleted outright.
 */
export const READ_WINDOW_BYTES = 64 * 1024;

/**
 * The kinds of run the queue serialises, and the npm script each one is.
 *
 * Separate lanes with separate limits rather than one pool, because they are not the same load: a
 * unit run saturates every core, while `tsc` is effectively single-threaded and spends its budget
 * on an 8 GB heap (see scripts/typecheck.mjs). One shared number would either starve the
 * typechecks behind a suite or let several suites run at once; there is no value right for both.
 *
 * `capWorkers` says whether `--max-workers` means anything to that script. tsc has no worker pool,
 * so handing it the flag would be an unknown argument rather than a smaller run.
 *
 * `resultCache` is a SEPARATE question and must stay one. It says whether the run is one the test
 * result cache can skip files in - which is the `unit` projects and nothing else, because the
 * sequencer only ever skips there (see the note above `sequence.sequencer` in vitest.config.mts).
 * The two were one flag while every lane answered them the same way; the browser and workspace
 * suites are the case that separates them. They take `--max-workers` and must NOT take the cache
 * reporter, which would otherwise attach to a run it can skip nothing in and write its ledger
 * entries anyway.
 */
/**
 * What a lane COSTS, as against how many of it may run.
 *
 * Per-lane limits alone are not resource management. Before this table the only admission
 * condition was `runningFor(kind) >= limits[kind]`, so six lanes at 1 each let six runs start
 * together: about 62 vitest workers on a 32-core box, two 8 GB tsc heaps, and a browser suite,
 * all at once. Separate limits made the oversubscription orderly rather than smaller.
 *
 * A group is the shared budget. `saturating` holds the runs that each want most of the machine on
 * their own, so only one of them runs at a time whichever lane it came from. `light` holds the
 * ones that want a core and a large heap, which can sit beside a saturating run without competing
 * for CPU in any way that matters.
 *
 * 🔴 This deliberately does NOT make the queue first-come. A cheap typecheck can still overtake a
 * queued suite, and that is the property the lanes were added for: an edit/verify loop that waits
 * behind someone else's 500-second suite is the condition this whole queue exists to end. If you
 * are here to make it strictly fair, that is a product decision, not a cleanup - it was taken
 * deliberately on 2026-09-22.
 */
export const RUN_GROUPS = {
  saturating: { defaultConcurrency: 1, configKey: 'saturatingConcurrency', flag: '--saturating' },
  light: { defaultConcurrency: 2, configKey: 'lightConcurrency', flag: '--light' },
};

export const RUN_KINDS = {
  unit: {
    script: 'test:unit:run',
    capWorkers: true,
    resultCache: true,
    group: 'saturating',
    defaultConcurrency: 1,
    // The wire name this lane's limit takes in /test-runs/config, and the CLI operand that sets
    // it. The unit lane is the bare `concurrency` and the bare positional operand because it was
    // the only lane once; renaming it now would break every caller and every doc for nothing.
    configKey: 'concurrency',
    flag: null,
  },
  typecheck: {
    script: 'typecheck',
    capWorkers: false,
    resultCache: false,
    group: 'light',
    defaultConcurrency: 1,
    configKey: 'typecheckConcurrency',
    flag: '--typecheck',
  },
  typecheckApps: {
    script: 'typecheck:apps',
    capWorkers: false,
    resultCache: false,
    group: 'light',
    defaultConcurrency: 1,
    configKey: 'typecheckAppsConcurrency',
    flag: '--typecheck-apps',
  },
  // Its own lane rather than a share of the unit one: this is the pair CLAUDE.md names, where a
  // 31-worker unit run and 12 Chromium instances ran beside each other because only one of them
  // was arbitrated.
  component: {
    script: 'test:component',
    capWorkers: true,
    resultCache: false,
    group: 'saturating',
    // Vitest's browser pool is min(12, cpus - 1), but `getThreadsCount` returns a caller's
    // `--max-workers` UNCLAMPED - so the queue's own cap, set for vitest workers, would launch
    // that many Chromium instances instead. 15 is past what upstream calls safe.
    maxWorkersCeiling: 12,
    defaultConcurrency: 1,
    configKey: 'componentConcurrency',
    flag: '--component',
  },
  packages: {
    script: 'test:packages:run',
    capWorkers: true,
    resultCache: false,
    group: 'saturating',
    defaultConcurrency: 1,
    configKey: 'packagesConcurrency',
    flag: '--packages',
  },
  apps: {
    script: 'test:apps:run',
    capWorkers: true,
    resultCache: false,
    group: 'saturating',
    defaultConcurrency: 1,
    configKey: 'appsConcurrency',
    flag: '--apps',
  },
  // A second browser project, so the same ceiling applies for the same reason.
  geometry: {
    script: 'test:geometry',
    capWorkers: true,
    resultCache: false,
    group: 'saturating',
    maxWorkersCeiling: 12,
    defaultConcurrency: 1,
    configKey: 'geometryConcurrency',
    flag: '--geometry',
  },
  // eslint is one process with no worker pool, so `--max-workers` means nothing to it and it sits
  // in `light` beside the typechecks rather than taking a saturating slot it would not fill.
  lint: {
    script: 'lint',
    capWorkers: false,
    resultCache: false,
    group: 'light',
    defaultConcurrency: 1,
    configKey: 'lintConcurrency',
    flag: '--lint',
  },
  lintPackages: {
    script: 'lint:packages',
    capWorkers: false,
    resultCache: false,
    group: 'light',
    defaultConcurrency: 1,
    configKey: 'lintPackagesConcurrency',
    flag: '--lint-packages',
  },
};

export const DEFAULT_KIND = 'unit';

/**
 * The `{ <configKey>: n }` body that a `test config` command's arguments ask for, one entry per
 * lane whose flag was typed. Lives here rather than inline in the CLI because the collision rule
 * below is the whole reason it is not a one-line findIndex, and inline it could not be tested.
 *
 * The unit lane has no flag: it is the bare positional operand, parsed by the caller.
 */
export function laneConcurrencyArgs(rest) {
  const body = {};
  // Lanes AND groups, one parser: their configKeys share a namespace on the wire, so parsing them
  // apart would be two places to forget a new one.
  for (const spec of [...Object.values(RUN_KINDS), ...Object.values(RUN_GROUPS)]) {
    if (!spec.flag) continue;
    // Anchored on the whole flag or on `flag=`, never a bare prefix: `--typecheck` matching
    // `--typecheck-apps` as a prefix would set the WRONG lane's limit and then report back the
    // lane you asked for, which reads as the command having worked.
    const at = rest.findIndex((a) => a === spec.flag || String(a).startsWith(spec.flag + '='));
    if (at === -1) continue;
    const typed = String(rest[at]);
    const inline = typed.includes('=') ? typed.slice(spec.flag.length + 1) : rest[at + 1];
    body[spec.configKey] = Number(inline);
  }
  return body;
}

export function normalizeKind(kind) {
  if (kind === undefined || kind === null || kind === '') return DEFAULT_KIND;
  if (!Object.prototype.hasOwnProperty.call(RUN_KINDS, kind)) {
    throw new Error(`unknown run kind: ${kind} (want one of ${Object.keys(RUN_KINDS).join(', ')})`);
  }
  return kind;
}

export const DEFAULT_CONCURRENCY = 1;
// null, not a number: no cap is not the same decision as a cap that happens to equal today's core
// count, and only the first one keeps following the box when it changes.
export const DEFAULT_MAX_WORKERS = null;
const DEFAULT_ABANDON_AFTER_MS = 10 * 60 * 1000;
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 30 * 1000;
const MAX_LOG_LINES = 2000;
const KEEP_FINISHED = 50;
const DEFAULT_WAIT_COMMAND = 'node .claude/skills/dev-server/cli.mjs test wait';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timeout', 'abandoned', 'error']);

export function isTerminal(status) {
  return TERMINAL.has(status);
}

/**
 * The exit code a waiter should exit with. Only a completed run that itself exited 0 is a pass:
 * a cancelled or timed-out run can carry exitCode 0 (the child exited cleanly in the window
 * between the kill being issued and it landing), and treating that as success would report a
 * green suite that never finished.
 */
export function exitCodeFor(run) {
  if (run.status === 'completed' && run.exitCode === 0) return 0;
  // A real failing code is worth passing through, but a child killed by a signal reports no code
  // at all (recorded as -1), and exiting -1 gives a shell 255 — a number that means nothing here
  // and that `[ $? -eq 1 ]` misreads.
  return Number.isInteger(run.exitCode) && run.exitCode > 0 ? run.exitCode : 1;
}

/**
 * Where a run's output is captured while it runs.
 *
 * A FILE, not a pipe, and that is the whole fix for the drop. Node makes a child's stdout
 * synchronous when it refers to a regular file and asynchronous when it refers to a pipe — so a
 * child that calls `process.exit()` with data still queued on a pipe DISCARDS it, before the
 * parent ever receives it. Measured on this box: 5,000 lines written, 172 recorded, 11,932 of
 * 353,893 bytes delivered, every missing line a contiguous tail. The same child exiting naturally
 * delivered all 353,893 bytes.
 *
 * That also rules out the fix that looks obvious from the daemon's side. The daemon cannot detect
 * the loss by reading: it sees a clean EOF and there is no signal to compare against. And the
 * child is vitest, so "flush before exit" is not ours to call. Handing it a file is the only one
 * of the three that needs no cooperation from the thing losing the data.
 *
 * One file for both streams rather than two, so the interleaving a reader depends on is the real
 * one. The cost is that stdout and stderr are no longer distinguishable, which is why lines are
 * recorded as `output` rather than claiming to be one or the other — nothing renders the level for
 * a test run (both consumers print `entry.message`), and a label we cannot support is worse than
 * an honest one.
 */
export function createOutputCapture(onLine) {
  const path = join(tmpdir(), `civitai-test-run-${process.pid}-${randomUUID()}.log`);
  const writeFd = openSync(path, 'a');
  let readFd;
  try {
    readFd = openSync(path, 'r');
  } catch (err) {
    closeSync(writeFd);
    throw err;
  }

  let offset = 0;
  // The tail of a read that stopped mid-line. Without it, a line straddling a read boundary is
  // torn in two and BOTH halves are recorded as lines — which corrupted the log even when every
  // byte arrived: 5,000 lines in, 4,998 recognised, 6 fragments invented, 353,893/353,893 bytes.
  let carry = '';
  // A carry buffer fixes a torn LINE and does nothing for a torn CHARACTER. Decoding each read
  // independently turned a 3-byte `⎯` starting at byte 65535 into THREE U+FFFD — and vitest's
  // failure output is built from `⎯`/`✓`/`×`/`❯`, one boundary per 64 KiB. The decoder holds an
  // incomplete sequence back until the bytes that finish it arrive.
  const decoder = new StringDecoder('utf8');

  // Hoisted: the tail runs 10x a second per run, and this was a fresh allocation each time.
  const buf = Buffer.allocUnsafe(READ_WINDOW_BYTES);

  const drain = (final = false) => {
    for (;;) {
      let read = 0;
      try {
        // Explicit position, so this never moves the shared write offset.
        read = readSync(readFd, buf, 0, buf.length, offset);
      } catch (err) {
        // Same argument as the short-read break below: stopping here silently would report a
        // clipped log with `logsDropped: 0`, which is the one thing the queue's log contract
        // promises cannot happen. A read we cannot complete is said out loud instead.
        if (final) onLine(`[capture truncated: ${err?.code ?? err?.message ?? String(err)}]`);
        break;
      }
      if (read <= 0) break;
      offset += read;
      carry += decoder.write(buf.subarray(0, read));
      const lines = carry.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onLine(line.trim());
      // A short read means EOF on a regular file, so the incremental drain can stop there.
      //
      // This has effect on exactly ONE path, and the honest scope is worth stating: on the
      // `finish()` path the writer is already dead, so a short read IS EOF and `!final` changes
      // nothing. It matters on `dispose()`, where force-release fires precisely because the child
      // did NOT die and may still be appending. There, stopping at the first short read would
      // report a clipped log with `logsDropped: 0`. Bounded: against a maximally fast live writer
      // this returned in 89.5 ms having read 2,082,688 lines.
      if (read < buf.length && !final) break;
    }
    // Anything the decoder is still holding is an incomplete sequence at EOF; flush it so the
    // bytes are visible as replacement chars rather than silently dropped.
    if (final) carry += decoder.end();
    // A run whose last line has no trailing newline still emitted that line.
    if (final && carry.trim()) {
      onLine(carry.trim());
      carry = '';
    }
  };

  const close = () => {
    for (const fd of [readFd, writeFd]) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  };

  return { path, writeFd, drain, close };
}

/**
 * The `--max-workers` argument a queued run should carry, if any.
 *
 * Vitest sizes its own pool at `cpus - 1`, which is right for a queue of one and wrong the moment
 * two runs share the box: at concurrency 2 an uncapped pair asks for 62 workers on 32 cores.
 * `VITEST_MAX_WORKERS` cannot do this job here — the daemon spawns the child with the DAEMON's
 * environment, so the caller's copy never arrives and the daemon's own is fixed at whatever it was
 * started with. The CLI flag is forwarded through `pnpm run` into vitest, and is the only knob that
 * reaches a queued run.
 *
 * A caller who passed their own `--max-workers` keeps it: they asked for a specific width, and a
 * second copy of the flag would decide the run by argument order rather than by intent.
 */
export function workerCapArgv(maxWorkers, args, ceiling = null) {
  // A lane's ceiling applies even when the queue is uncapped, because it is a property of that
  // runner rather than of how busy the box is.
  const width = maxWorkers && ceiling ? Math.min(maxWorkers, ceiling) : maxWorkers || ceiling;
  if (!width) return [];
  // Both spellings: vitest reads kebab and camel as one flag (see canonicalFlag in
  // scripts/test-component-run.mjs), so matching only `--max-workers` would miss a caller's
  // `--maxWorkers=3` and append a second, conflicting width after it.
  if (args.some((a) => /^--max(?:-w|W)orkers(?:=|$)/.test(String(a)))) return [];
  return [`--max-workers=${width}`];
}

/**
 * The `--max-workers` operand as typed. `none` (or no operand) is the ONLY way back to an uncapped
 * pool, and it has to stay the only one: `Number('1O')` is NaN, `JSON.stringify` writes NaN as
 * `null`, and the daemon reads null as "no cap" — so a typo silently removed the cap this setting
 * exists to impose. `concurrency` already rejects the same input, because its normalizer refuses
 * null; only this flag was asymmetric.
 */
export function parseMaxWorkersFlag(raw) {
  // A MISSING operand is an error, not an uncap. `test config 4 --max-workers` is a truncated
  // command, and reading it as "remove the cap" is the same silent uncap this function exists to
  // stop, one keystroke away. `none` is the spelling that means it.
  if (raw === 'none') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--max-workers wants an integer >= 1 or 'none', got: ${raw}`);
  }
  return n;
}

export const CACHE_MODES = ['off', 'shadow', 'on'];

// The WORKTREE's copy, not the daemon's: the sequencer and fs tracker come from that tree's
// vitest config, and all three must share one key definition (scripts/test-cache/core.mjs) or
// every lookup misses. A tree without the files simply runs uncached.
export const cacheReporterPath = (worktree) =>
  join(worktree, 'scripts', 'test-cache', 'reporter.mjs');

/**
 * The reporter arguments a queued unit run should carry. The reporter is passed on the command line
 * rather than from the config because a caller's own `--reporter` replaces config reporters — and
 * that would drop the false-skip check while the sequencer went on skipping. Naming any
 * `--reporter` also replaces vitest's default, so a caller who named none gets `default` back.
 */
export function cacheReporterArgv(cacheMode, args, reporterPath) {
  if (cacheMode === 'off') return [];
  if (!reporterPath || !existsSync(reporterPath)) return [];
  const named = args.some((a) => /^--reporter(?:=|$)/.test(String(a)));
  return [...(named ? [] : ['--reporter=default']), `--reporter=${reporterPath}`];
}

export function defaultStartRun({
  worktree,
  args,
  onLog,
  onExit,
  maxWorkers = null,
  kind = DEFAULT_KIND,
  cacheMode = 'off',
}) {
  const emitter = new EventEmitter();
  const isWindows = process.platform === 'win32';
  const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm';
  const { script, capWorkers, resultCache, maxWorkersCeiling = null } =
    RUN_KINDS[normalizeKind(kind)];
  const argv = [
    'run',
    script,
    ...args,
    ...(capWorkers ? workerCapArgv(maxWorkers, args, maxWorkersCeiling) : []),
    // Cached lanes only. The reporter is a vitest reporter, so a non-vitest lane would reject the
    // flag outright - and a vitest lane the cache can skip nothing in would accept it and report
    // on a run it never influenced.
    ...(resultCache ? cacheReporterArgv(cacheMode, args, cacheReporterPath(worktree)) : []),
  ];

  onLog('info', `> ${pnpm} ${argv.join(' ')}`);

  let capture;
  try {
    capture = createOutputCapture((line) => onLog('output', line));
  } catch (err) {
    queueMicrotask(() => onExit(-1, `could not open a capture file: ${err.message}`));
    emitter.kill = () => {};
    emitter.dispose = () => {};
    return emitter;
  }

  let child;
  try {
    child = spawn(pnpm, argv, {
      cwd: worktree,
      // The command above is the script that routes to this queue. Inheriting the flag makes it
      // enqueue a second run and wait for it, while this one holds the slot that run needs — a
      // deadlock on every full-suite run, not a race. Concurrency is not the fix: each logical run
      // would need two slots, so N agents starting together still fill them all with waiters.
      env: {
        ...process.env,
        CIVITAI_TEST_QUEUE: '0',
        // Read by the worktree's vitest config, sequencer, tracker and reporter alike.
        CIVITAI_TEST_CACHE: RUN_KINDS[normalizeKind(kind)].resultCache ? cacheMode : 'off',
      },
      // The same fd twice: one file description, one shared offset, so the two streams append in
      // the order they were actually written. See createOutputCapture.
      stdio: ['ignore', capture.writeFd, capture.writeFd],
      shell: isWindows,
      windowsHide: true,
      // Its own process group, so the kill below can take the whole vitest tree. Without this,
      // killing by negative pid names no group, fails with ESRCH, and leaves the run burning
      // cores while its slot is handed to the next caller.
      detached: !isWindows,
    });
  } catch (err) {
    capture.close();
    queueMicrotask(() => onExit(-1, err.message));
    emitter.kill = () => {};
    emitter.dispose = () => {};
    return emitter;
  }

  // Polled rather than watched: fs.watch's semantics differ per platform and it can miss an
  // append entirely. The interval only decides how LIVE the log is — completeness comes from the
  // final drain below, which runs after the writer is gone.
  const tail = setInterval(() => capture.drain(), 100);
  // So a forgotten run can never hold the daemon open.
  tail.unref?.();

  let finished = false;
  const finish = (code, error) => {
    if (finished) return;
    finished = true;
    clearInterval(tail);
    // Ordering is the point. Every remaining line is read BEFORE the run is reported terminal,
    // so a waiter that wakes on the terminal status cannot observe a log that is still filling.
    // The old pipe path could call onExit with lines still in flight.
    //
    // `finally`, because draining calls back into `onLog`: a consumer that throws would otherwise
    // leave both descriptors open and the capture file on disk. Scope, stated honestly: the
    // daemon's own `onLog` is `addLog`, which cannot throw, so no daemon run reaches this today —
    // it is cheap insurance against a future consumer, not a live leak.
    try {
      capture.drain(true);
    } finally {
      capture.close();
    }
    onExit(code, error);
  };

  child.on('exit', (code) => finish(code ?? -1));
  child.on('error', (err) => finish(-1, err.message));

  /**
   * Release the capture without an exit.
   *
   * `finish` is bound to the child's own 'exit', and there are two live paths where that event
   * never comes: the sweep's force-release past the kill grace — the wedge this queue exists to
   * prevent — and daemon shutdown. Both used to drop the queue's last reference to the handle
   * while the interval, both descriptors and an unbounded /tmp file stayed alive inside the
   * closure. Measured on a forced run: 2 fds still open, the log still growing 2s after the run
   * was reported terminal (logIndex 75 -> 471), file 102,465 bytes and climbing, never unlinked.
   *
   * Idempotent, and it deliberately does NOT call onExit: the caller has already settled the run.
   */
  emitter.dispose = () => {
    if (finished) return;
    finished = true;
    clearInterval(tail);
    // See finish(): the close is in `finally` so a throwing log consumer cannot leak the
    // descriptors and the file.
    try {
      capture.drain(true);
    } finally {
      capture.close();
    }
  };

  emitter.pid = child.pid;
  // `sync` is for daemon shutdown, where an asynchronously spawned taskkill would never get to
  // run before the daemon exits, leaving vitest orphaned and still holding every core.
  emitter.kill = (sync = false) => {
    try {
      if (isWindows) {
        const argv = ['/pid', String(child.pid), '/f', '/t'];
        // The sync form runs on the daemon's event loop, including inside the SIGINT handler.
        // Without a timeout a taskkill that blocks would wedge the daemon with no way to shut it
        // down; a kill we cannot complete is better abandoned, since the sweep frees the slot.
        if (sync)
          execFileSync('taskkill', argv, { stdio: 'ignore', timeout: 5000, windowsHide: true });
        else spawn('taskkill', argv, { shell: true, windowsHide: true });
      } else {
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch {
      /* already gone, or refused — the sweep releases the slot either way */
    }
  };
  return emitter;
}

let counter = 0;
function nextId() {
  counter += 1;
  return `t${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export class TestQueue {
  constructor(options = {}) {
    const {
      concurrency = DEFAULT_CONCURRENCY,
      groupConcurrency = undefined,
      maxWorkers = DEFAULT_MAX_WORKERS,
      cacheMode = 'off',
      startRun = defaultStartRun,
      now = () => Date.now(),
      abandonAfterMs = DEFAULT_ABANDON_AFTER_MS,
      runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
      killGraceMs = DEFAULT_KILL_GRACE_MS,
      waitCommand = DEFAULT_WAIT_COMMAND,
    } = options;

    this.limits = normalizeLimits(concurrency);
    this.groupLimits = normalizeGroupLimits(groupConcurrency);
    this.maxWorkers = normalizeMaxWorkers(maxWorkers);
    this.cacheMode = normalizeCacheMode(cacheMode);
    this.startRun = startRun;
    this.now = now;
    this.abandonAfterMs = abandonAfterMs;
    this.runTimeoutMs = runTimeoutMs;
    this.killGraceMs = killGraceMs;
    this.waitCommand = waitCommand;

    this.runs = new Map();
    this.order = [];
    this.running = new Set();
  }

  /**
   * The unit lane's limit. Kept under the bare name `concurrency` because the daemon, the CLI and
   * the waiter all read it off a run view, and answering "which lane?" to that question would
   * break every one of them over a setting most callers never touch.
   */
  get concurrency() {
    return this.limits[DEFAULT_KIND];
  }

  concurrencyFor(kind) {
    return this.limits[normalizeKind(kind)];
  }

  runningFor(kind) {
    const want = normalizeKind(kind);
    let n = 0;
    for (const id of this.running) if (this.runs.get(id)?.kind === want) n += 1;
    return n;
  }

  queuedFor(kind) {
    const want = normalizeKind(kind);
    return this.order.reduce((n, id) => n + (this.runs.get(id)?.kind === want ? 1 : 0), 0);
  }

  pausedFor(kind) {
    return this.limits[normalizeKind(kind)] === 0;
  }

  /** The UNIT lane, for the callers that predate lanes. Ask `pausedFor` for any other. */
  get paused() {
    return this.pausedFor(DEFAULT_KIND);
  }

  request({ worktree, args = [], kind = DEFAULT_KIND } = {}) {
    if (!worktree) throw new Error('worktree is required');
    // Rejected BEFORE anything is recorded: an unknown kind must not leave a run in the map that
    // no lane will ever pump, which is an entry that waits forever while reporting position 1.
    const runKind = normalizeKind(kind);
    const at = this.now();
    const run = {
      id: nextId(),
      worktree,
      args,
      kind: runKind,
      status: 'queued',
      enqueuedAt: at,
      touchedAt: at,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      error: null,
      handle: null,
      killRequestedAt: null,
      cancelReason: null,
      timedOut: false,
      logs: [],
      logIndex: 0,
      // Counted, not just done. A reader cannot tell a clipped log from a whole one, so the
      // number of lines the window threw away has to travel with the run.
      logsDropped: 0,
    };
    this.runs.set(run.id, run);
    this.order.push(run.id);
    this.pump();
    return this.view(run.id);
  }

  /** Reading a run is also the liveness signal that keeps a queued entry from being swept. */
  get(id) {
    const run = this.runs.get(id);
    if (!run) return null;
    run.touchedAt = this.now();
    return this.view(id);
  }

  list() {
    return Array.from(this.runs.keys()).map((id) => this.view(id));
  }

  logs(id, since = -1) {
    const run = this.runs.get(id);
    if (!run) return null;
    run.touchedAt = this.now();
    return run.logs.filter((entry) => entry.index > since);
  }

  /** How many of a run's lines the window has thrown away, for readers that fetch logs directly. */
  droppedFor(id) {
    return this.runs.get(id)?.logsDropped ?? 0;
  }

  cancel(id, reason = 'cancelled') {
    const run = this.runs.get(id);
    if (!run) return null;
    if (isTerminal(run.status)) return this.view(id);
    if (run.status === 'running') {
      run.cancelReason = reason;
      run.killRequestedAt = this.now();
      run.handle?.kill();
      return this.view(id);
    }
    this.dequeue(id);
    this.settle(run, 'cancelled', null, reason === 'cancelled' ? null : reason);
    return this.view(id);
  }

  setGroupConcurrency(value, group) {
    const name = normalizeGroupName(group);
    this.groupLimits[name] = normalizeConcurrency(value);
    this.pump();
    return this.groupLimits[name];
  }

  setConcurrency(value, kind = DEFAULT_KIND) {
    const lane = normalizeKind(kind);
    this.limits[lane] = normalizeConcurrency(value);
    this.pump();
    return this.limits[lane];
  }

  /**
   * Takes effect on the NEXT run to start, never on one already running — the width is fixed when
   * vitest is spawned. Nothing here kills a run to resize it.
   */
  /** Like the worker cap: applies to the next run to start, never to one already running. */
  setCacheMode(value) {
    this.cacheMode = normalizeCacheMode(value);
    return this.cacheMode;
  }

  setMaxWorkers(value) {
    this.maxWorkers = normalizeMaxWorkers(value);
    return this.maxWorkers;
  }

  /**
   * Deadlines, driven by the injected clock rather than a timer. Returns what it acted on so a
   * caller (and a test) can assert on it rather than infer it.
   */
  sweep() {
    const at = this.now();
    const swept = { abandoned: [], timedOut: [], forced: [] };

    for (const id of [...this.order]) {
      const run = this.runs.get(id);
      if (at - run.touchedAt < this.abandonAfterMs) continue;
      this.dequeue(id);
      this.settle(run, 'abandoned', null);
      swept.abandoned.push(id);
    }

    for (const id of [...this.running]) {
      const run = this.runs.get(id);
      if (!run || run.startedAt === null) continue;

      // A kill that produced no exit would hold the slot forever — which is the wedge this queue
      // exists to prevent. Past the grace, detach the handle (so a late exit cannot double-settle)
      // and free the slot on our own authority.
      if (run.killRequestedAt !== null && at - run.killRequestedAt >= this.killGraceMs) {
        // Before dropping the reference: the handle owns a capture file, two descriptors and a
        // tail interval, and none of them are released by anything else on this path.
        //
        // Guarded, because `dispose()` does real IO and calls back into `onLog`. If it throws,
        // everything below — the detach, the release, the settle — is skipped and the slot is
        // held forever, which is the wedge this branch exists to break. Measured with a throwing
        // dispose: status `running`, running.size 1, against `cancelled` / 0 when it returns.
        // Releasing the slot matters more than releasing the file descriptors.
        try {
          run.handle?.dispose?.();
        } catch (err) {
          // The slot is freed regardless — but silently swallowing this would hide a clipped log
          // behind `logsDropped: 0`, which is exactly what the truncation marker exists to stop.
          this.addLog(run, 'error', `capture release failed: ${err?.message ?? String(err)}`);
        }
        run.handle = null;
        this.release(id);
        this.settle(
          run,
          run.timedOut ? 'timeout' : 'cancelled',
          null,
          'process did not exit after kill; slot released anyway'
        );
        swept.forced.push(id);
        continue;
      }

      if (run.killRequestedAt !== null) continue;
      if (at - run.startedAt < this.runTimeoutMs) continue;
      run.timedOut = true;
      run.killRequestedAt = at;
      run.handle?.kill();
      swept.timedOut.push(id);
    }

    if (swept.abandoned.length || swept.forced.length) this.pump();
    return swept;
  }

  shutdown() {
    for (const id of [...this.running]) {
      const run = this.runs.get(id);
      run.cancelReason = 'daemon-shutdown';
      run.killRequestedAt = this.now();
      // Not guarded, unlike the dispose below, and the asymmetry is deliberate: `defaultStartRun`
      // puts its whole kill body inside its own try/catch, and the daemon always uses that runner
      // (the daemon's is the only PRODUCTION `new TestQueue`, and it passes no `startRun`; the
      // other constructions are in tests). Nothing here can throw.
      run.handle?.kill(true);

      // Dispose, then settle HERE — the two go together, and the first version shipped only the
      // first half.
      //
      // `dispose()` sets the same `finished` flag `finish()` guards on, so the SIGKILLed child's
      // 'exit' arrives and returns early: `onExit` never fires. Without settling on this side,
      // the run stays `running` and `running.size` never drops, so `pump()` can never start
      // another run — the queue is wedged, which is the exact failure it exists to prevent.
      // Measured: 300 ms after shutdown(), status `running` and running.size 1, against
      // `cancelled` / 0 when the dispose is removed.
      //
      // Today every caller exits the process straight after, so nothing observes the wedge. That
      // is not a reason to leave it: each one first awaits rgbProxy.stop(), authHub.stop() and
      // stopSpokeApps(), and if any of those hangs the daemon stays up and serving with a queue
      // that can never run anything again.
      //
      // (An earlier comment here claimed the capture file would otherwise "survive the daemon
      // every time". That was wrong — measured in both arms, the file was unlinked either way,
      // because the daemon does linger long enough for the child's exit. The dispose earns its
      // place by releasing the interval and the descriptors deterministically, not by that.)
      // Guarded for the same reason as the sweep's force-release: a throwing dispose must not
      // skip the settle below and leave the queue wedged — and it would also abort this loop,
      // leaving every remaining run unkilled and the caller's `process.exit(0)` unreached.
      try {
        run.handle?.dispose?.();
      } catch (err) {
        this.addLog(run, 'error', `capture release failed: ${err?.message ?? String(err)}`);
      }
      run.handle = null;
      this.release(id);
      this.settle(run, 'cancelled', null, 'daemon-shutdown');
    }
  }

  // --- internals ---

  runningForGroup(group) {
    let n = 0;
    for (const id of this.running) {
      const kind = this.runs.get(id)?.kind;
      if (kind && RUN_KINDS[kind]?.group === group) n += 1;
    }
    return n;
  }

  groupConcurrencyFor(group) {
    return this.groupLimits[group];
  }

  pump() {
    // Two conditions, not one. The LANE limit keeps a kind from stacking on itself; the GROUP
    // limit is the shared budget that stops four lanes that each want the whole box from starting
    // together. Per-lane alone was orderly oversubscription, not arbitration.
    //
    // Each lane still takes only ITS OWN head of the queue, so a light run is not stuck behind a
    // saturating one it shares no budget with — the property the lanes were added for.
    for (const kind of Object.keys(RUN_KINDS)) {
      const group = RUN_KINDS[kind].group;
      for (;;) {
        if (this.runningFor(kind) >= this.limits[kind]) break;
        if (this.runningForGroup(group) >= this.groupLimits[group]) break;
        const at = this.order.findIndex((id) => this.runs.get(id)?.kind === kind);
        if (at === -1) break;
        this.start(this.order.splice(at, 1)[0]);
      }
    }
  }

  start(id) {
    const run = this.runs.get(id);
    if (!run || run.status !== 'queued') return;

    run.status = 'running';
    run.startedAt = this.now();
    run.touchedAt = run.startedAt;
    this.running.add(id);

    const onLog = (level, message) => this.addLog(run, level, message);

    // The exit path is built BEFORE the runner is called. A runner that reports its exit
    // synchronously would otherwise report into a listener that does not exist yet, leaving a
    // finished run holding the only slot until the run ceiling expires.
    let settled = false;
    let handle = null;
    const onExit = (code, errorMessage) => {
      // A run only settles once, and only from the handle it currently owns: a late exit from a
      // replaced handle must neither settle it nor release a slot it no longer holds.
      if (settled || (handle !== null && run.handle !== handle)) return;
      settled = true;
      run.handle = null;
      this.release(id);
      this.settle(run, this.outcomeFor(run, code), code, errorMessage ?? run.cancelReason ?? null);
      this.pump();
    };

    try {
      handle = this.startRun({
        worktree: run.worktree,
        args: run.args,
        onLog,
        onExit,
        maxWorkers: this.maxWorkers,
        kind: run.kind,
        cacheMode: this.cacheMode,
      });
    } catch (err) {
      // A runner that reported an exit and then threw has already produced a verdict; overwriting
      // it here would replace a real result with the noise that followed it.
      if (settled) return;
      this.release(id);
      this.settle(run, 'error', null, err.message);
      this.pump();
      return;
    }

    if (settled) return; // the runner reported an exit before it returned a handle
    run.handle = handle;
    handle.on?.('exit', onExit);
  }

  outcomeFor(run, code) {
    if (run.timedOut) return 'timeout';
    if (run.cancelReason) return 'cancelled';
    if (code === 0) return 'completed';
    // No exit code means the child died by signal or never started — an OOM kill, not a verdict
    // on the tests. Calling that `failed` would report a test result nothing produced.
    return code < 0 ? 'error' : 'failed';
  }

  release(id) {
    this.running.delete(id);
  }

  dequeue(id) {
    const at = this.order.indexOf(id);
    if (at !== -1) this.order.splice(at, 1);
  }

  settle(run, status, exitCode, error = null) {
    run.status = status;
    run.exitCode = exitCode;
    run.error = error;
    run.finishedAt = this.now();
    this.prune();
  }

  prune() {
    const finished = Array.from(this.runs.values())
      .filter((run) => isTerminal(run.status))
      .sort((a, b) => a.finishedAt - b.finishedAt);
    while (finished.length > KEEP_FINISHED) this.runs.delete(finished.shift().id);
  }

  addLog(run, level, message) {
    run.logs.push({ index: run.logIndex++, level, message, at: this.now() });
    if (run.logs.length > MAX_LOG_LINES) {
      run.logs.shift();
      run.logsDropped += 1;
    }
  }

  /**
   * Position within the run's OWN lane, not within `order`. A typecheck sitting behind four queued
   * suites it will never wait for is at position 1, and reporting 5 there is a number the caller
   * then budgets against for no reason.
   */
  positionOf(id) {
    const run = this.runs.get(id);
    if (!run) return 0;
    let n = 0;
    for (const queuedId of this.order) {
      if (this.runs.get(queuedId)?.kind !== run.kind) continue;
      n += 1;
      if (queuedId === id) return n;
    }
    return 0;
  }

  view(id) {
    const run = this.runs.get(id);
    if (!run) return null;
    return {
      id: run.id,
      status: run.status,
      worktree: run.worktree,
      args: run.args,
      kind: run.kind,
      // Exact, not estimated, and LANE-SCOPED: the index among queued runs of this kind. 0 means
      // "not waiting behind anyone" in its own lane, which is the only lane that can delay it.
      position: this.positionOf(id),
      queueLength: this.queuedFor(run.kind),
      running: this.runningFor(run.kind),
      concurrency: this.limits[run.kind],
      maxWorkers: this.maxWorkers,
      cacheMode: this.cacheMode,
      paused: this.pausedFor(run.kind),
      enqueuedAt: run.enqueuedAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      exitCode: run.exitCode,
      error: run.error,
      logIndex: run.logIndex,
      // How many lines this run emitted that the window no longer holds. Non-zero means every
      // reader of these logs — waiter, `test logs`, a pasted excerpt — is looking at a fragment.
      logsDropped: run.logsDropped,
      waitCommand: `${this.waitCommand} ${run.id}`,
    };
  }
}

function normalizeCacheMode(value) {
  const mode = value === undefined || value === null || value === '' ? 'off' : String(value);
  if (!CACHE_MODES.includes(mode)) {
    throw new Error(`cacheMode must be one of ${CACHE_MODES.join(', ')}, got: ${value}`);
  }
  return mode;
}

/**
 * Same defensive shape as normalizeConcurrency, with one difference that matters: 0 is REJECTED
 * rather than treated as a pause. `--max-workers=0` is not a smaller run, it is a run with no
 * workers, and vitest's own resolution treats a falsy value as "unset" — so a 0 that slipped
 * through here would silently restore the uncapped pool the setting exists to prevent.
 */
function normalizeMaxWorkers(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`maxWorkers must be an integer >= 1, or null for no cap, got: ${value}`);
  }
  return parsed;
}

/**
 * Accepts the old scalar as well as a per-lane object. The scalar sets the UNIT lane only and
 * leaves the others at their defaults — reinterpreting it as "every lane" would silently raise the
 * typecheck limit on every machine that had ever set TEST_CONCURRENCY for the suite.
 */
function normalizeGroupName(group) {
  if (!Object.prototype.hasOwnProperty.call(RUN_GROUPS, group)) {
    throw new Error(`unknown run group: ${group} (want one of ${Object.keys(RUN_GROUPS).join(', ')})`);
  }
  return group;
}

function normalizeGroupLimits(value) {
  const limits = {};
  for (const [group, spec] of Object.entries(RUN_GROUPS)) limits[group] = spec.defaultConcurrency;
  if (value === undefined || value === null) return limits;
  for (const [group, n] of Object.entries(value)) {
    limits[normalizeGroupName(group)] = normalizeConcurrency(n);
  }
  return limits;
}

function normalizeLimits(value) {
  const limits = {};
  for (const [kind, spec] of Object.entries(RUN_KINDS)) limits[kind] = spec.defaultConcurrency;
  if (value === undefined || value === null) return limits;
  if (typeof value === 'object') {
    for (const [kind, n] of Object.entries(value)) {
      limits[normalizeKind(kind)] = normalizeConcurrency(n);
    }
    return limits;
  }
  limits[DEFAULT_KIND] = normalizeConcurrency(value);
  return limits;
}

function normalizeConcurrency(value) {
  const parsed = typeof value === 'number' ? value : parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`concurrency must be an integer >= 0 (0 pauses the queue), got: ${value}`);
  }
  return parsed;
}
