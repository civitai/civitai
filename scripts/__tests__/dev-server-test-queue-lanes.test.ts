import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it } from 'vitest';

import * as QueueModule from '../../.claude/skills/dev-server/scripts/test-queue.mjs';

// The module is plain .mjs, so TS infers `request`'s payload from nothing and lands on types no
// call here can satisfy. Named once instead of cast at every call site.
type Kind = 'unit' | 'typecheck';
type View = {
  id: string;
  kind: Kind;
  status: string;
  position: number;
  queueLength: number;
  running: number;
  concurrency: number;
};
type Queue = {
  request: (run: { worktree: string; args?: string[]; kind?: string }) => View;
  get: (id: string) => View;
  list: () => View[];
  setConcurrency: (value: number, kind?: Kind) => number;
  concurrencyFor: (kind: Kind) => number;
  pausedFor: (kind: Kind) => boolean;
  paused: boolean;
  setMaxWorkers: (value: number | null) => number | null;
  maxWorkers: number | null;
};
type Runner = EventEmitter & { finish: (code: number) => void; kind: Kind; worktree: string };
type RunnerArgs = { worktree: string; kind: Kind };

const { TestQueue, parseMaxWorkersFlag } = QueueModule as unknown as {
  parseMaxWorkersFlag: (raw: string | undefined) => number | null;
  TestQueue: new (options: Record<string, unknown>) => Queue;
};

let started: Runner[];

const build = (concurrency: unknown) =>
  new TestQueue({
    concurrency,
    now: () => 1_000,
    startRun: ({ worktree, kind }: RunnerArgs) => {
      const handle = new EventEmitter() as Runner;
      handle.finish = (code) => handle.emit('exit', code);
      handle.kind = kind;
      handle.worktree = worktree;
      started.push(handle);
      return handle;
    },
  });

beforeEach(() => {
  started = [];
});

/**
 * 🔴 The property the lanes exist for. If you are here because this fails after collapsing the
 * lanes back into one pool: that is the regression, not a stale test. A single pool puts a
 * one-core typecheck behind every queued 31-worker suite, which is the "everything crawls"
 * condition this was built to end.
 */
describe('a typecheck does not wait behind the unit lane', () => {
  it('starts immediately while the unit lane is full and has runs queued ahead of it', () => {
    const queue = build({ unit: 1, typecheck: 1 });
    queue.request({ worktree: '/wt/suite-a' });
    queue.request({ worktree: '/wt/suite-b' });
    queue.request({ worktree: '/wt/suite-c' });

    const check = queue.request({ worktree: '/wt/tc', kind: 'typecheck' });

    expect(check.status).toBe('running');
    expect(started.map((r) => `${r.kind}:${r.worktree}`)).toEqual([
      'unit:/wt/suite-a',
      'typecheck:/wt/tc',
    ]);
  });

  // Position is within the run's own lane. Counting the suites in `order` would tell a caller they
  // are fourth in line for a slot they will never wait on.
  it("reports a queued typecheck's position within its own lane only", () => {
    const queue = build({ unit: 1, typecheck: 1 });
    queue.request({ worktree: '/wt/suite-a' });
    queue.request({ worktree: '/wt/suite-b' });
    queue.request({ worktree: '/wt/suite-c' });
    queue.request({ worktree: '/wt/tc-running', kind: 'typecheck' });

    const waiting = queue.request({ worktree: '/wt/tc-waiting', kind: 'typecheck' });

    expect(waiting.status).toBe('queued');
    expect(waiting.position).toBe(1);
    expect(waiting.queueLength).toBe(1);
  });
});

describe('each lane enforces its own limit', () => {
  it('holds a second typecheck while the first runs, even with the unit lane idle', () => {
    const queue = build({ unit: 4, typecheck: 1 });
    queue.request({ worktree: '/wt/tc-1', kind: 'typecheck' });

    const second = queue.request({ worktree: '/wt/tc-2', kind: 'typecheck' });

    expect(second.status).toBe('queued');
    expect(started).toHaveLength(1);
  });

  it('holds a second suite while the first runs, even with the typecheck lane idle', () => {
    const queue = build({ unit: 1, typecheck: 4 });
    queue.request({ worktree: '/wt/suite-a' });

    const second = queue.request({ worktree: '/wt/suite-b' });

    expect(second.status).toBe('queued');
    expect(started).toHaveLength(1);
  });

  it('frees a lane slot only for that lane', () => {
    const queue = build({ unit: 1, typecheck: 1 });
    queue.request({ worktree: '/wt/suite-a' });
    const waitingSuite = queue.request({ worktree: '/wt/suite-b' });
    queue.request({ worktree: '/wt/tc-1', kind: 'typecheck' });
    const waitingCheck = queue.request({ worktree: '/wt/tc-2', kind: 'typecheck' });

    started.find((r) => r.kind === 'typecheck')!.finish(0);

    expect(queue.get(waitingCheck.id).status).toBe('running');
    expect(queue.get(waitingSuite.id).status).toBe('queued');
  });

  it('starts waiting typechecks when their lane is raised at runtime', () => {
    const queue = build({ unit: 1, typecheck: 1 });
    queue.request({ worktree: '/wt/tc-1', kind: 'typecheck' });
    const second = queue.request({ worktree: '/wt/tc-2', kind: 'typecheck' });

    queue.setConcurrency(2, 'typecheck');

    expect(queue.get(second.id).status).toBe('running');
  });
});

describe('configuring the lanes', () => {
  /**
   * The scalar form is what every existing caller passes, from TEST_CONCURRENCY. Reading it as
   * "every lane" would quietly raise the typecheck limit on any machine that had only ever tuned
   * the suite — nobody who set that variable asked for more concurrent tsc heaps.
   */
  it('reads a bare number as the unit lane only', () => {
    const queue = build(3);

    expect(queue.concurrencyFor('unit')).toBe(3);
    expect(queue.concurrencyFor('typecheck')).toBe(1);
  });

  it('refuses an unknown kind without recording a run no lane would ever start', () => {
    const queue = build({ unit: 1, typecheck: 1 });

    expect(() => queue.request({ worktree: '/wt/x', kind: 'lint' })).toThrow(/unknown run kind/);
    expect(queue.list()).toEqual([]);
  });

  // `paused` is the unit lane, for the callers that predate lanes. A pause reported against the
  // wrong lane is worse than none: a typecheck stopped by `--typecheck 0` sat at position 1 and
  // read as merely waiting its turn.
  it('reports a pause against the lane that is actually paused', () => {
    const queue = build({ unit: 2, typecheck: 0 });

    expect(queue.pausedFor('typecheck')).toBe(true);
    expect(queue.pausedFor('unit')).toBe(false);
    expect(queue.paused).toBe(false);
  });
});

describe('the --max-workers operand', () => {
  /**
   * `none` has to be the only spelling that uncaps the pool. `Number('1O')` is NaN, JSON writes NaN
   * as `null`, and the daemon reads null as "no cap" — so before this, a typo was indistinguishable
   * from the deliberate escape hatch and silently removed the cap.
   */
  it.each([['1O'], ['eight'], ['--cache'], ['0'], ['-4'], ['2.5'], ['']])(
    'refuses %j rather than uncapping',
    (raw) => {
      expect(() => parseMaxWorkersFlag(raw)).toThrow(/integer >= 1 or 'none'/);
    }
  );

  it('accepts a positive integer and the explicit escape hatch', () => {
    expect(parseMaxWorkersFlag('8')).toBe(8);
    expect(parseMaxWorkersFlag('none')).toBeNull();
  });

  // A truncated `test config 4 --max-workers` is a typo, not a request to uncap — the same silent
  // uncap this parser exists to stop, one keystroke away. `none` is how you say it on purpose.
  it('refuses a missing operand rather than reading it as none', () => {
    expect(() => parseMaxWorkersFlag(undefined)).toThrow(/integer >= 1 or 'none'/);
  });

  // Why the parser has to refuse rather than coerce: null IS the uncap, on the queue that the CLI
  // is posting to. Nothing downstream can tell an accidental null from a deliberate one.
  it('treats null as the uncap it is, so nothing may produce one by accident', () => {
    const queue = build({ unit: 1, typecheck: 1 });
    queue.setMaxWorkers(4);
    expect(queue.maxWorkers).toBe(4);

    queue.setMaxWorkers(null);
    expect(queue.maxWorkers).toBeNull();
  });
});
