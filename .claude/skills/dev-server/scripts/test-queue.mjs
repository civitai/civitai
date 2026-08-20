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
import { closeSync, openSync, readSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { StringDecoder } from 'string_decoder';

export const DEFAULT_CONCURRENCY = 1;
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

  // Hoisted: the tail runs 10x a second per run, and this was a fresh 64 KiB allocation each time.
  const buf = Buffer.allocUnsafe(64 * 1024);

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
        if (final) onLine(`[capture truncated: ${err.code ?? err.message}]`);
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

export function defaultStartRun({ worktree, args, onLog, onExit }) {
  const emitter = new EventEmitter();
  const isWindows = process.platform === 'win32';
  const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm';
  const argv = ['run', 'test:unit:run', ...args];

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
      env: { ...process.env, CIVITAI_TEST_QUEUE: '0' },
      // The same fd twice: one file description, one shared offset, so the two streams append in
      // the order they were actually written. See createOutputCapture.
      stdio: ['ignore', capture.writeFd, capture.writeFd],
      shell: isWindows,
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
    capture.drain(true);
    capture.close();
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
    capture.drain(true);
    capture.close();
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
      startRun = defaultStartRun,
      now = () => Date.now(),
      abandonAfterMs = DEFAULT_ABANDON_AFTER_MS,
      runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
      killGraceMs = DEFAULT_KILL_GRACE_MS,
      waitCommand = DEFAULT_WAIT_COMMAND,
    } = options;

    this.concurrency = normalizeConcurrency(concurrency);
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

  get paused() {
    return this.concurrency === 0;
  }

  request({ worktree, args = [] } = {}) {
    if (!worktree) throw new Error('worktree is required');
    const at = this.now();
    const run = {
      id: nextId(),
      worktree,
      args,
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

  setConcurrency(value) {
    this.concurrency = normalizeConcurrency(value);
    this.pump();
    return this.concurrency;
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
        run.handle?.dispose?.();
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
      run.handle?.dispose?.();
      run.handle = null;
      this.release(id);
      this.settle(run, 'cancelled', null, 'daemon-shutdown');
    }
  }

  // --- internals ---

  pump() {
    while (this.running.size < this.concurrency && this.order.length > 0) {
      this.start(this.order.shift());
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
      handle = this.startRun({ worktree: run.worktree, args: run.args, onLog, onExit });
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

  positionOf(id) {
    const at = this.order.indexOf(id);
    return at === -1 ? 0 : at + 1;
  }

  view(id) {
    const run = this.runs.get(id);
    if (!run) return null;
    return {
      id: run.id,
      status: run.status,
      worktree: run.worktree,
      args: run.args,
      // Exact, not estimated: the index in one ordered array. 0 means "not waiting behind anyone".
      position: this.positionOf(id),
      queueLength: this.order.length,
      running: this.running.size,
      concurrency: this.concurrency,
      paused: this.paused,
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

function normalizeConcurrency(value) {
  const parsed = typeof value === 'number' ? value : parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`concurrency must be an integer >= 0 (0 pauses the queue), got: ${value}`);
  }
  return parsed;
}
