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

export function defaultStartRun({ worktree, args, onLog, onExit }) {
  const emitter = new EventEmitter();
  const isWindows = process.platform === 'win32';
  const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm';
  const argv = ['run', 'test:unit:run', ...args];

  onLog('info', `> ${pnpm} ${argv.join(' ')}`);

  let child;
  try {
    child = spawn(pnpm, argv, {
      cwd: worktree,
      // The command above is the script that routes to this queue. Inheriting the flag makes it
      // enqueue a second run and wait for it, while this one holds the slot that run needs — a
      // deadlock on every full-suite run, not a race. Concurrency is not the fix: each logical run
      // would need two slots, so N agents starting together still fill them all with waiters.
      // The command above is the script that routes to this queue. Inheriting the flag makes it
      // enqueue a second run and wait for it, while this one holds the slot that run needs — a
      // deadlock on every full-suite run, not a race. Concurrency is not the fix: each logical run
      // would need two slots, so N agents starting together still fill them all with waiters.
      env: { ...process.env, CIVITAI_TEST_QUEUE: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows,
      // Its own process group, so the kill below can take the whole vitest tree. Without this,
      // killing by negative pid names no group, fails with ESRCH, and leaves the run burning
      // cores while its slot is handed to the next caller.
      detached: !isWindows,
    });
  } catch (err) {
    queueMicrotask(() => onExit(-1, err.message));
    emitter.kill = () => {};
    return emitter;
  }

  const pipe = (stream, level) =>
    stream.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        if (line.trim()) onLog(level, line.trim());
      }
    });
  pipe(child.stdout, 'stdout');
  pipe(child.stderr, 'stderr');

  child.on('exit', (code) => onExit(code ?? -1));
  child.on('error', (err) => onExit(-1, err.message));

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
