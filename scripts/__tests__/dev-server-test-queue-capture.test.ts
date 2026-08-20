import type * as ChildProcess from 'child_process';
import { EventEmitter } from 'events';
import { existsSync, writeSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const { createOutputCapture, defaultStartRun } = await import(
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
      const READ_WINDOW = 64 * 1024;
      // Pad so the 3-byte U+23AF begins one byte before the window ends, splitting it 1 + 2.
      const pad = Buffer.alloc(READ_WINDOW - 1, 0x61); // 'a'
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
      // Land a line's midpoint exactly past the 64 KiB buffer: pad to just under, then write a
      // marked line long enough to cross it.
      const READ_WINDOW = 64 * 1024;
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
