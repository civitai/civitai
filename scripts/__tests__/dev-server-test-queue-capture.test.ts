import type * as ChildProcess from 'child_process';
import { EventEmitter } from 'events';
import { closeSync, existsSync, openSync, readdirSync, rmSync, writeFileSync, writeSync } from 'fs';
import { dirname, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const { createOutputCapture, defaultStartRun, READ_WINDOW_BYTES } = await import(
  '../../.claude/skills/dev-server/scripts/test-queue.mjs'
);

// The mock above replaces `spawn` for EVERY importer, this file included — so a plain
// `import { spawn }` here would hand back the mock and the "real child" cases would spawn
// nothing. importActual is how a test that mocks a module still reaches the genuine one.
const { spawn: realSpawn } = await vi.importActual<typeof ChildProcess>('child_process');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

/**
 * A child that writes N numbered lines and then calls `process.exit()` — the exact shape that
 * loses output down a pipe. Numbered, because a COUNT alone cannot tell truncation (a prefix
 * survives, the tail is gone) from sampling (gaps throughout), and the two point at different
 * causes.
 */
const WRITER = `
const N = Number(process.argv[1]);
for (let i = 1; i <= N; i++) process.stdout.write('LINE ' + i + ' ' + 'x'.repeat(60) + '\\n');
process.exit(0);
`;

afterEach(() => vi.clearAllMocks());

describe('a run that exits without flushing still has all of its output', () => {
  /** Runs the writer against a capture and returns what the capture recorded. */
  function capture(n: number) {
    return new Promise<{ lines: string[]; path: string }>((done) => {
      const lines: string[] = [];
      const cap = createOutputCapture((line: string) => lines.push(line));
      const child = realSpawn(process.execPath, ['--input-type=module', '-e', WRITER, String(n)], {
        stdio: ['ignore', cap.writeFd, cap.writeFd],
      });
      const tail = setInterval(() => cap.drain(), 20);
      child.on('exit', () => {
        clearInterval(tail);
        cap.drain(true);
        const { path } = cap;
        cap.close();
        done({ lines, path });
      });
    });
  }

  /**
   * The regression. Measured head-to-head against the mechanism this replaces, same child, same
   * process: through PIPES the parent received 172 of 5,000 lines with a slow consumer (three
   * identical runs) and 1,473 on one of three fast runs; through the FILE, 5,000 of 5,000 on all
   * six. Node makes a child's stdout synchronous for a regular file and asynchronous for a pipe,
   * so `process.exit()` can discard a pipe's queue and cannot discard a file's.
   */
  it('records every line of a 5,000-line run', async () => {
    const { lines } = await capture(5000);

    const numbers = new Set<number>();
    let malformed = 0;
    for (const line of lines) {
      const m = /^LINE (\d+) x{60}$/.exec(line);
      if (m) numbers.add(Number(m[1]));
      else malformed += 1;
    }

    // Three distinct claims. The count catches loss; the distinct count catches a duplicate
    // standing in for a missing line; malformed catches a line torn at a read boundary and
    // recorded as two.
    expect(lines).toHaveLength(5000);
    expect(numbers.size).toBe(5000);
    expect(malformed).toBe(0);
  }, 60_000);

  it('cleans up its capture file', async () => {
    const { path } = await capture(10);
    expect(existsSync(path)).toBe(false);
  }, 30_000);

  /**
   * A carry buffer fixes a torn LINE and does nothing for a torn CHARACTER. Decoding each read
   * independently turned a 3-byte `⎯` starting at byte 65535 into THREE U+FFFD, with the original
   * gone — and vitest builds its failure output from `⎯`/`✓`/`×`/`❯`, with one boundary every
   * 64 KiB. The straddle case below is ASCII and structurally cannot see this.
   */
  it('does not corrupt a multi-byte character split across the read window', () => {
    const lines: string[] = [];
    const cap = createOutputCapture((line: string) => lines.push(line));
    try {
      // The module's own window, not a copy of the number: with a hand-copied 64 KiB here, the
      // whole suite passed at a 128 KiB window with the StringDecoder deleted outright.
      const READ_WINDOW = READ_WINDOW_BYTES;
      // Pad so the 3-byte U+23AF begins one byte before the window ends, splitting it 1 + 2.
      const pad = Buffer.alloc(READ_WINDOW - 1, 0x61); // 'a'
      // The control this test needs and its sibling already has: without a straddle the
      // assertion below is satisfied by a character that never crossed a boundary, and passes
      // with the StringDecoder removed entirely. Pin that the character STARTS inside the first
      // read window and ENDS outside it.
      expect(pad.length).toBeLessThan(READ_WINDOW);
      expect(pad.length + Buffer.byteLength('⎯', 'utf8')).toBeGreaterThan(READ_WINDOW);
      writeSync(cap.writeFd, pad);
      writeSync(cap.writeFd, Buffer.from('⎯MARKER\n', 'utf8'));

      cap.drain(true);

      const marked = lines.filter((l) => l.includes('MARKER'));
      expect(marked).toHaveLength(1);
      expect(marked[0].endsWith('⎯MARKER')).toBe(true);
      // The control: no replacement character anywhere. Without the decoder this line carries
      // three of them in place of the `⎯`.
      expect(marked[0]).not.toContain('�');
    } finally {
      cap.close();
    }
  });
});

/**
 * The second defect, and it is independent of the first: with every byte delivered, the old
 * per-chunk `split('\n')` still tore any line straddling a read boundary into two, recording
 * BOTH halves as lines. Measured at 5,000 lines: 4,998 recognised, 6 fragments invented, and
 * 353,893 of 353,893 bytes — complete delivery, corrupted log. `logsDropped` reports 0 for this,
 * correctly, which is what makes it invisible.
 */
describe('a line that straddles a read boundary survives whole', () => {
  it('does not tear a line across the 64 KiB read window', () => {
    const lines: string[] = [];
    const cap = createOutputCapture((line: string) => lines.push(line));
    try {
      // Land a line's midpoint exactly past the read window: pad to just under, then write a
      // marked line long enough to cross it. Taken from the module so widening it there cannot
      // silently make this control vacuous.
      const READ_WINDOW = READ_WINDOW_BYTES;
      const filler = `${'f'.repeat(99)}\n`;
      const padding = filler.repeat(Math.floor((READ_WINDOW - 50) / filler.length));
      const straddler = `STRADDLE-${'s'.repeat(400)}-END`;
      writeSync(cap.writeFd, `${padding}${straddler}\n`);

      cap.drain(true);

      const found = lines.filter((l) => l.includes('STRADDLE'));
      expect(found).toHaveLength(1);
      expect(found[0]).toBe(straddler);
      // The positive control, pinned from both sides. `> READ_WINDOW` alone is also satisfied if
      // the padding ALREADY exceeded the window, which would put the line wholly inside the
      // second read and never exercise the hazard.
      expect(padding.length).toBeLessThan(READ_WINDOW);
      expect(padding.length + straddler.length).toBeGreaterThan(READ_WINDOW);
    } finally {
      cap.close();
    }
  });

  // A child killed mid-sequence leaves an incomplete character at EOF. Without `decoder.end()`
  // those bytes are dropped silently; with it they surface as U+FFFD, which is a visible
  // artefact rather than an absent one. That distinction is the whole point of the log contract.
  it('surfaces an incomplete trailing character rather than dropping it', () => {
    const lines: string[] = [];
    const cap = createOutputCapture((line: string) => lines.push(line));
    try {
      // The first two bytes of a 3-byte U+23AF, and nothing more — a killed writer's tail.
      writeSync(cap.writeFd, Buffer.from([0xe2, 0x8e]));

      cap.drain(true);

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('\ufffd');
    } finally {
      cap.close();
    }
  });

  /**
   * A final drain that cannot read must SAY so. Stopping silently would hand back a clipped log
   * with `logsDropped: 0` — a complete-looking record of an incomplete run, which is the one
   * thing the queue's log contract promises cannot happen.
   */
  it('says so when the final drain cannot read, instead of returning a short log', () => {
    const lines: string[] = [];
    const cap = createOutputCapture((line: string) => lines.push(line));
    writeSync(cap.writeFd, 'delivered\n');
    cap.drain();
    // Releasing the descriptors out from under the capture is the reachable way to make the
    // final read fail; the queue's own dispose path closes them for real.
    cap.close();

    cap.drain(true);

    expect(lines[0]).toBe('delivered');
    expect(lines.some((l) => l.startsWith('[capture truncated:'))).toBe(true);
  });

  it('emits a final line that has no trailing newline, but only on the final drain', () => {
    const lines: string[] = [];
    const cap = createOutputCapture((line: string) => lines.push(line));
    try {
      writeSync(cap.writeFd, 'complete line\nno trailing newline');

      cap.drain();
      // Mid-run it is not a line yet — the writer may still be mid-write.
      expect(lines).toEqual(['complete line']);

      cap.drain(true);
      expect(lines).toEqual(['complete line', 'no trailing newline']);
    } finally {
      cap.close();
    }
  });
});

/**
 * The seam. The capture above can be perfect and the queue can still hand its child a pipe — the
 * two are different files and nothing else here loads both. This asserts the mechanism is wired
 * in, by reading the stdio the queue actually passes to spawn.
 */
describe('the queue hands its child the capture file, not a pipe', () => {
  it('passes one file descriptor for both stdout and stderr', () => {
    const child = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn() });
    spawnMock.mockReturnValue(child);

    defaultStartRun({ worktree: repoRoot, args: [], onLog: () => {}, onExit: () => {} });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const stdio = (spawnMock.mock.calls[0][2] as { stdio: unknown[] }).stdio;
    expect(stdio[0]).toBe('ignore');
    // Numbers, not 'pipe' — that difference IS the fix.
    expect(typeof stdio[1]).toBe('number');
    expect(stdio[1]).not.toBe('pipe');
    // The SAME descriptor for both, so the two streams share one offset and interleave in the
    // order they were written. Two descriptors would reorder them.
    expect(stdio[2]).toBe(stdio[1]);

    child.emit('exit', 0);
  });

  it('records lines at the level the trade-off claims, not a stream it cannot know', () => {
    const child = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn() });
    spawnMock.mockReturnValue(child);

    const levels: string[] = [];
    const handle = defaultStartRun({
      worktree: repoRoot,
      args: [],
      onLog: (level: string) => levels.push(level),
      onExit: () => {},
    });
    const stdio = (spawnMock.mock.calls[0][2] as { stdio: number[] }).stdio;
    writeSync(stdio[1], 'a line\n');
    child.emit('exit', 0);
    handle.dispose();

    // One file cannot tell stdout from stderr, so claiming either would be a false label in
    // stored data. `info` is the queue's own preamble line; captured output is `output`.
    expect(levels.filter((l) => l !== 'info')).toEqual(['output']);
  });

  /**
   * The capture has to be releasable WITHOUT an exit, because two live paths never produce one:
   * the sweep's force-release past the kill grace — the wedge this queue exists to prevent — and
   * daemon shutdown. Both dropped the queue's last reference while the interval, both descriptors
   * and an unbounded /tmp file stayed alive in the closure.
   */
  it('releases the capture when the child never exits', () => {
    const child = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn() });
    spawnMock.mockReturnValue(child);

    let exits = 0;
    const handle = defaultStartRun({
      worktree: repoRoot,
      args: [],
      onLog: () => {},
      onExit: () => (exits += 1),
    });
    const stdio = (spawnMock.mock.calls[0][2] as { stdio: number[] }).stdio;

    handle.dispose();

    // The descriptor is closed, so a write to it now throws — that is the observable proof the
    // fds were released, rather than a claim that dispose() was called.
    expect(() => writeSync(stdio[1], 'x')).toThrow();
    // The caller has already settled the run; disposing must not settle it a second time.
    expect(exits).toBe(0);
    // Idempotent — shutdown may dispose a handle the sweep already did.
    expect(() => handle.dispose()).not.toThrow();
    // And a late exit after disposal cannot re-enter finish().
    child.emit('exit', 0);
    expect(exits).toBe(0);
  });

  /**
   * dispose() must READ before it releases, and release in the right order.
   *
   * Both halves were unpinned. `capture.drain(true)` after `capture.close()` emits nothing at all
   * — everything the child wrote is silently lost — and this is the one path where the child is
   * KNOWN to still be producing output, because force-release fires exactly when a kill did not
   * take. The ordering is load-bearing rather than cosmetic: fd numbers are reused, so a tail
   * interval surviving a close would read whatever file next claimed that descriptor and splice
   * its bytes into this run's log.
   */
  it('drains before releasing the descriptors', () => {
    const child = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn() });
    spawnMock.mockReturnValue(child);

    const messages: string[] = [];
    const handle = defaultStartRun({
      worktree: repoRoot,
      args: [],
      onLog: (_level: string, message: string) => messages.push(message),
      onExit: () => {},
    });
    const stdio = (spawnMock.mock.calls[0][2] as { stdio: number[] }).stdio;
    writeSync(stdio[1], 'written but never drained\n');

    handle.dispose();

    // Drained, not lost — this fails outright if dispose closes before draining.
    expect(messages).toContain('written but never drained');
    // The descriptor is closed.
    expect(() => writeSync(stdio[1], 'x')).toThrow();
  });

  /**
   * The tail must actually STOP, and this is not cosmetic.
   *
   * I previously argued this mutant had no observable effect because a surviving interval would
   * just throw on the closed descriptor. That is wrong, and measurably so: descriptor NUMBERS are
   * reused, so once the next `openSync` claims the freed fd the surviving interval reads whatever
   * file now owns it and splices those bytes into a terminal run's log. Measured against the
   * mechanism: 4,246 lines of an unrelated file, versus 0 with the clearInterval in place.
   *
   * Driven with fake timers so the 100 ms tick is reached without waiting for it.
   */
  it('stops the tail, so a reused descriptor cannot splice another file into the log', () => {
    vi.useFakeTimers();
    const foreign = resolve(tmpdir(), `civitai-fd-probe-${process.pid}-${Date.now()}.log`);
    const foreignFds: number[] = [];
    try {
      const child = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn() });
      spawnMock.mockReturnValue(child);

      const messages: string[] = [];
      const handle = defaultStartRun({
        worktree: repoRoot,
        args: [],
        onLog: (_level: string, message: string) => messages.push(message),
        onExit: () => {},
      });
      const stdio = (spawnMock.mock.calls[0][2] as { stdio: number[] }).stdio;

      handle.dispose();
      const before = messages.length;

      // Claim the descriptors the capture just released, and fill the new file with something
      // unmistakable. A surviving tail would read THIS.
      //
      // BOTH of them, and that detail is the test: the capture closed two fds, `openSync` hands
      // back the LOWEST free number, and the tail reads from `readFd` — the higher of the pair.
      // Claiming only one takes writeFd's number and the mutant goes unobserved, which is exactly
      // how the first version of this test passed against a surviving interval.
      writeFileSync(foreign, 'FOREIGN-SECRET\n'.repeat(500));
      foreignFds.push(openSync(foreign, 'r'), openSync(foreign, 'r'));

      // The self-check. This case only has teeth if the reclamation actually happened — if it
      // ever stops, `readSync` gets EBADF, `drain()` breaks silently, and the test goes on
      // passing while protecting nothing.
      expect(foreignFds).toContain(stdio[1]);

      vi.advanceTimersByTime(1000);

      expect(messages.slice(before)).toEqual([]);
      expect(messages.some((m) => m.includes('FOREIGN-SECRET'))).toBe(false);
    } finally {
      for (const fd of foreignFds) closeSync(fd);
      rmSync(foreign, { force: true });
      vi.useRealTimers();
    }
  });

  /**
   * A log consumer that throws must not cost the descriptors and the file.
   *
   * Draining calls back into `onLog`. With the close outside a `finally`, a throwing consumer
   * left BOTH descriptors open and the capture file on disk — measured — per run, in a daemon
   * that runs for days. The slot-freeing guard upstream then swallows it, so it would be silent
   * as well as leaky.
   */
  it('releases the descriptors and the file even when the log consumer throws', () => {
    const child = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn() });
    spawnMock.mockReturnValue(child);

    let seen = 0;
    const handle = defaultStartRun({
      worktree: repoRoot,
      args: [],
      onLog: (_level: string, message: string) => {
        // The queue's own preamble line arrives first; blow up on captured output.
        if (message.startsWith('boom')) {
          seen += 1;
          throw new Error('log consumer blew up');
        }
      },
      onExit: () => {},
    });
    const stdio = (spawnMock.mock.calls[0][2] as { stdio: number[] }).stdio;
    // Scoped to THIS process. The prefix alone matches every capture in /tmp, including one the
    // operator's own daemon creates whenever it runs a queued test — so the unscoped form asserts
    // that a file it does not own has been deleted, and goes red with no defect present. Measured:
    // a single foreign file made the unmutated test fail, and made three mutants report a false
    // KILLED. The filename carries the owning pid precisely so this can be scoped.
    const capturePath = readdirSync(tmpdir())
      .filter((f) => f.startsWith(`civitai-test-run-${process.pid}-`))
      .map((f) => resolve(tmpdir(), f));
    // The positive control for the scope above. An empty list makes every deletion assertion
    // below a no-op loop that passes trivially — so if the filename format ever changes, this
    // fails loudly instead of the suite quietly protecting nothing. Measured at exactly 1.
    expect(capturePath).toHaveLength(1);
    writeSync(stdio[1], 'boom one\nboom two\n');

    expect(() => handle.dispose()).toThrow(/log consumer blew up/);

    expect(seen).toBeGreaterThan(0);
    // Released despite the throw: the descriptor is closed and the file is gone.
    expect(() => writeSync(stdio[1], 'x')).toThrow();
    for (const p of capturePath) expect(existsSync(p)).toBe(false);
  });

  /**
   * The same release guarantee on the path every healthy run takes.
   *
   * `finish()` and `dispose()` have the identical drain-then-close shape, and the first version of
   * the throwing-consumer test drove only `dispose()`. Reverting `finish()`'s try/finally survived
   * the entire suite — the headline change of its own round, untested, on the common path.
   */
  it('releases the descriptors on a normal exit even when the log consumer throws', () => {
    const child = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn() });
    spawnMock.mockReturnValue(child);

    let seen = 0;
    defaultStartRun({
      worktree: repoRoot,
      args: [],
      onLog: (_level: string, message: string) => {
        if (message.startsWith('boom')) {
          seen += 1;
          throw new Error('log consumer blew up');
        }
      },
      onExit: () => {},
    });
    const stdio = (spawnMock.mock.calls[0][2] as { stdio: number[] }).stdio;
    const mine = readdirSync(tmpdir())
      .filter((f) => f.startsWith(`civitai-test-run-${process.pid}-`))
      .map((f) => resolve(tmpdir(), f));
    // Same positive control as above: an empty list would make the loop below vacuous.
    expect(mine).toHaveLength(1);
    writeSync(stdio[1], 'boom one\nboom two\n');

    // The real exit path, not dispose().
    expect(() => child.emit('exit', 0)).toThrow(/log consumer blew up/);

    expect(seen).toBeGreaterThan(0);
    expect(() => writeSync(stdio[1], 'x')).toThrow();
    for (const f of mine) expect(existsSync(f)).toBe(false);
  });

  /**
   * The same hazard on the path every healthy run takes.
   *
   * `finish()` and `dispose()` have the identical clearInterval -> drain -> close shape, and the
   * previous round pinned only `dispose()` — the RARER of the two. `finish()` runs on every
   * normal child exit, so a stray interval there is the common case, not the edge case.
   */
  it('stops the tail on a normal exit too, not just on dispose', () => {
    vi.useFakeTimers();
    const foreign = resolve(tmpdir(), `civitai-fd-probe-${process.pid}-${Date.now()}-exit.log`);
    const foreignFds: number[] = [];
    try {
      const child = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn() });
      spawnMock.mockReturnValue(child);

      const messages: string[] = [];
      defaultStartRun({
        worktree: repoRoot,
        args: [],
        onLog: (_level: string, message: string) => messages.push(message),
        onExit: () => {},
      });
      const stdio = (spawnMock.mock.calls[0][2] as { stdio: number[] }).stdio;

      child.emit('exit', 0);
      const before = messages.length;

      writeFileSync(foreign, 'FOREIGN-SECRET\n'.repeat(500));
      foreignFds.push(openSync(foreign, 'r'), openSync(foreign, 'r'));
      expect(foreignFds).toContain(stdio[1]);

      vi.advanceTimersByTime(1000);

      expect(messages.slice(before)).toEqual([]);
      expect(messages.some((m) => m.includes('FOREIGN-SECRET'))).toBe(false);
    } finally {
      for (const fd of foreignFds) closeSync(fd);
      rmSync(foreign, { force: true });
      vi.useRealTimers();
    }
  });

  /**
   * The ordering invariant, and it is the half that actually protects a reader.
   *
   * A waiter wakes on the run's TERMINAL status and then reads the log. If the queue reports the
   * exit before it has read what the child wrote, the waiter sees a complete-looking log that is
   * still filling — the same false-green as losing the lines outright, arrived at differently.
   * The old pipe path could do exactly that, because 'exit' does not wait for pending 'data'.
   *
   * Driven through the real `defaultStartRun` with a fake child, writing to the very descriptor
   * the queue handed to spawn.
   */
  it('reads everything the child wrote BEFORE reporting the exit', () => {
    const child = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn() });
    spawnMock.mockReturnValue(child);

    const events: string[] = [];
    defaultStartRun({
      worktree: repoRoot,
      args: [],
      onLog: (_level: string, message: string) => events.push(`log:${message}`),
      onExit: (code: number) => events.push(`exit:${code}`),
    });

    const stdio = (spawnMock.mock.calls[0][2] as { stdio: number[] }).stdio;
    // Written and never drained by the interval — the child "exits" immediately after, so the
    // only thing that can have read these is the final drain inside the exit handler.
    writeSync(stdio[1], 'first\nsecond\nthird\n');

    child.emit('exit', 0);

    const exitAt = events.indexOf('exit:0');
    expect(exitAt).toBeGreaterThan(-1);
    expect(events.slice(0, exitAt)).toEqual(
      expect.arrayContaining(['log:first', 'log:second', 'log:third'])
    );
    // Stated as an index comparison too, so a reordering cannot hide behind arrayContaining.
    expect(events.indexOf('log:third')).toBeLessThan(exitAt);
  });
});
