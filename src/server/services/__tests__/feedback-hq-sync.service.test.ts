import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHqFeedbackReader,
  MAX_PAGES,
  resolveTaskTarget,
  runFeedbackHqSync,
  runFeedbackHqSyncGuarded,
  type FeedbackSyncRow,
  type HqTaskRow,
  type SyncDeps,
} from '~/server/services/feedback-hq-sync.service';

/**
 * The feedback ↔ HQ status sync: a feedback row's triage status follows the HQ task it was filed
 * under. Every write goes through the same compare-and-set triage write the queue and the API use
 * (here, the injected `triage`), so these tests pin WHICH write is asked for, and when none is.
 *
 * Every expectation is a literal. Ids are pairwise distinct, and distinct from the sync actor's.
 */

const ACTOR = 9001;
const HUMAN = 4242;
const url = (id: string) => `https://hq.civitai.com/t/${id}`;

type Call = Parameters<SyncDeps['triage']>[0];

const AREA = 'apps-platform';

/** Rows and links default to one area, so a case only names it when the area is what it tests. */
function deps(over: {
  links?: { feedbackId: number; taskId: string; area?: string }[];
  rows?: (Omit<FeedbackSyncRow, 'area'> & { area?: string })[];
  tasks?: Record<string, HqTaskRow | null | Error>;
  triage?: (call: Call) => 'changed' | 'conflict' | 'gone';
  clock?: () => number;
  deadlineMs?: number;
  maxTaskReads?: number;
}) {
  /** The write as asked for, without the handler guard (asserted separately in `handlers`). */
  const calls: Omit<Call, 'expectedHandledById'>[] = [];
  const handlers: (number | null | undefined)[] = [];
  const counted: Record<string, number> = {};
  const reads: string[] = [];
  const d: SyncDeps = {
    listLinks: vi.fn(async () => ({
      links: (over.links ?? []).map((l) => ({ area: AREA, ...l })),
      truncated: false,
    })),
    readRows: vi.fn(async (ids: number[]) =>
      (over.rows ?? []).filter((r) => ids.includes(r.id)).map((r) => ({ area: AREA, ...r }))
    ),
    readTask: vi.fn(async (id: string) => {
      reads.push(id);
      const t = over.tasks?.[id];
      if (t instanceof Error) throw t;
      return t === undefined ? null : t;
    }),
    triage: vi.fn(async (call: Call) => {
      const { expectedHandledById, ...rest } = call;
      calls.push(rest);
      handlers.push(expectedHandledById);
      return over.triage ? over.triage(call) : 'changed';
    }),
    actorId: ACTOR,
    count: (event, n = 1) => {
      counted[event] = (counted[event] ?? 0) + n;
    },
    log: vi.fn(),
    ...(over.clock ? { clock: over.clock } : {}),
    ...(over.deadlineMs !== undefined ? { deadlineMs: over.deadlineMs } : {}),
    ...(over.maxTaskReads !== undefined ? { maxTaskReads: over.maxTaskReads } : {}),
  };
  return { d, calls, handlers, counted, reads };
}

const open: HqTaskRow = { status: 'to do' };
const inProgress: HqTaskRow = { status: 'in progress' };
const complete: HqTaskRow = { status: 'complete', closed: '2026-11-12T19:08:52Z' };
const wontfix: HqTaskRow = { status: 'wontfix', closed: '2026-11-12T19:08:53Z' };

describe('resolveTaskTarget: the mapping table', () => {
  const read = (tasks: Record<string, HqTaskRow | null>) => async (id: string) =>
    tasks[id] === undefined ? null : tasks[id];

  it.each([
    ['an open task', open, { status: 'reviewed' }],
    ['a task in progress', inProgress, { status: 'reviewed' }],
    ['a completed task', complete, { status: 'actioned' }],
    ['a wontfix task that was not merged', wontfix, { status: 'dismissed' }],
    [
      'a closed task in a done status this sync does not know',
      { status: 'processed', closed: '2026-11-12T00:00:00Z' },
      { unresolved: 'unknown_done_status' },
    ],
  ])('%s', async (_label, task, expected) => {
    expect(await resolveTaskTarget('t_one', read({ t_one: task }))).toEqual(expected);
  });

  it('follows a merged task to the task it was merged into', async () => {
    const tasks = {
      t_dup: { ...wontfix, merged_into: 't_survivor' },
      t_survivor: complete,
    };
    expect(await resolveTaskTarget('t_dup', read(tasks))).toEqual({
      status: 'actioned',
      followed: ['t_survivor'],
    });
  });

  it('reads an hq:-prefixed merge target as the bare id', async () => {
    const tasks = { t_dup: { ...wontfix, merged_into: 'hq:t_open' }, t_open: open };
    expect(await resolveTaskTarget('t_dup', read(tasks))).toEqual({
      status: 'reviewed',
      followed: ['t_open'],
    });
  });

  it('never dismisses a merged task whose target cannot be read', async () => {
    const tasks = { t_dup: { ...wontfix, merged_into: 't_hidden' } };
    expect(await resolveTaskTarget('t_dup', read(tasks))).toEqual({
      unresolved: 'task_missing',
    });
  });

  it('follows ONE merge only: a merged task merged into another merged task stays unresolved', async () => {
    const tasks = {
      a1: { ...wontfix, merged_into: 'a2' },
      a2: { ...wontfix, merged_into: 'a3' },
      a3: complete,
    };
    expect(await resolveTaskTarget('a1', read(tasks))).toEqual({ unresolved: 'merge_too_deep' });
  });

  it('answers task_missing for a task HQ does not show', async () => {
    expect(await resolveTaskTarget('t_gone', read({}))).toEqual({ unresolved: 'task_missing' });
  });
});

describe('runFeedbackHqSync: forward only', () => {
  it('moves a new row to reviewed for an open task, recording the link', async () => {
    const { d, calls, counted } = deps({
      links: [{ feedbackId: 990000258, taskId: 't_open' }],
      rows: [{ id: 990000258, status: 'new', handledById: null, hqTaskId: null }],
      tasks: { t_open: open },
    });
    await runFeedbackHqSync(d);
    expect(calls).toEqual([
      { id: 990000258, status: 'reviewed', expectedStatus: 'new', hqTaskUrl: url('t_open') },
    ]);
    expect(counted).toMatchObject({ moved_reviewed: 1 });
  });

  it('moves a new row straight to actioned for a completed task', async () => {
    const { d, calls } = deps({
      links: [{ feedbackId: 990000250, taskId: 't_done' }],
      rows: [{ id: 990000250, status: 'new', handledById: null, hqTaskId: null }],
      tasks: { t_done: complete },
    });
    await runFeedbackHqSync(d);
    expect(calls).toEqual([
      { id: 990000250, status: 'actioned', expectedStatus: 'new', hqTaskUrl: url('t_done') },
    ]);
  });

  it('advances a row IT reviewed when the task completes, and does not re-send the link', async () => {
    const { d, calls, counted } = deps({
      links: [{ feedbackId: 990000251, taskId: 't_done' }],
      rows: [{ id: 990000251, status: 'reviewed', handledById: ACTOR, hqTaskId: 't_done' }],
      tasks: { t_done: complete },
    });
    await runFeedbackHqSync(d);
    expect(calls).toEqual([{ id: 990000251, status: 'actioned', expectedStatus: 'reviewed' }]);
    expect(counted).toMatchObject({ moved_actioned: 1 });
  });

  it('dismisses a row it reviewed when the task is a real wontfix', async () => {
    const { d, calls, counted } = deps({
      links: [{ feedbackId: 990000252, taskId: 't_no' }],
      rows: [{ id: 990000252, status: 'reviewed', handledById: ACTOR, hqTaskId: 't_no' }],
      tasks: { t_no: wontfix },
    });
    await runFeedbackHqSync(d);
    expect(calls).toEqual([{ id: 990000252, status: 'dismissed', expectedStatus: 'reviewed' }]);
    expect(counted).toMatchObject({ moved_dismissed: 1 });
  });

  it('never moves a row backwards: an open task leaves a row it reviewed alone', async () => {
    const { d, calls } = deps({
      links: [{ feedbackId: 990000253, taskId: 't_open' }],
      rows: [{ id: 990000253, status: 'reviewed', handledById: ACTOR, hqTaskId: 't_open' }],
      tasks: { t_open: open },
    });
    await runFeedbackHqSync(d);
    expect(calls).toEqual([]);
  });

  it.each(['actioned', 'dismissed'])(
    'never touches a %s row, even when its task reopened, and does not read the task',
    async (status) => {
      const { d, calls, reads } = deps({
        links: [{ feedbackId: 990000254, taskId: 't_open' }],
        rows: [{ id: 990000254, status, handledById: ACTOR, hqTaskId: 't_open' }],
        tasks: { t_open: open },
      });
      await runFeedbackHqSync(d);
      expect(calls).toEqual([]);
      expect(reads).toEqual([]);
    }
  );
});

describe('runFeedbackHqSync: a status a human set', () => {
  it('never dismisses a row a moderator reviewed: a wontfix task leaves it at reviewed', async () => {
    const { d, calls, counted } = deps({
      links: [{ feedbackId: 990000255, taskId: 't_no' }],
      rows: [{ id: 990000255, status: 'reviewed', handledById: HUMAN, hqTaskId: 't_no' }],
      tasks: { t_no: wontfix },
    });
    await runFeedbackHqSync(d);
    expect(calls).toEqual([]);
    expect(counted).toMatchObject({ human_set: 1 });
    expect(counted.moved_dismissed ?? 0).toBe(0);
  });

  it('never dismisses a row a moderator reviewed through a merge either', async () => {
    const { d, calls } = deps({
      links: [{ feedbackId: 990000259, taskId: 't_dup' }],
      rows: [{ id: 990000259, status: 'reviewed', handledById: HUMAN, hqTaskId: 't_dup' }],
      tasks: { t_dup: { ...wontfix, merged_into: 't_no' }, t_no: wontfix },
    });
    await runFeedbackHqSync(d);
    expect(calls).toEqual([]);
  });

  it('advances a row a moderator reviewed to actioned when its task completes', async () => {
    const { d, calls, counted } = deps({
      links: [{ feedbackId: 990000262, taskId: 't_done' }],
      rows: [{ id: 990000262, status: 'reviewed', handledById: HUMAN, hqTaskId: 't_done' }],
      tasks: { t_done: complete },
    });
    await runFeedbackHqSync(d);
    expect(calls).toEqual([{ id: 990000262, status: 'actioned', expectedStatus: 'reviewed' }]);
    expect(counted).toMatchObject({ moved_actioned: 1 });
    expect(counted.human_set ?? 0).toBe(0);
  });

  it('advances a row a moderator reviewed when the task it was merged into completes', async () => {
    const { d, calls } = deps({
      links: [{ feedbackId: 990000263, taskId: 't_dup' }],
      rows: [{ id: 990000263, status: 'reviewed', handledById: HUMAN, hqTaskId: 't_dup' }],
      tasks: { t_dup: { ...wontfix, merged_into: 't_done' }, t_done: complete },
    });
    await runFeedbackHqSync(d);
    expect(calls).toEqual([{ id: 990000263, status: 'actioned', expectedStatus: 'reviewed' }]);
  });

  it.each(['actioned', 'dismissed'])(
    'never touches a %s row a moderator set, even when its task disagrees',
    async (status) => {
      const { d, calls, reads } = deps({
        links: [{ feedbackId: 990000264, taskId: 't_open' }],
        rows: [{ id: 990000264, status, handledById: HUMAN, hqTaskId: 't_open' }],
        tasks: { t_open: open },
      });
      await runFeedbackHqSync(d);
      expect(calls).toEqual([]);
      expect(reads).toEqual([]);
    }
  );

  it('still records the link on a human-set row that lacks one, without changing its status', async () => {
    const { d, calls } = deps({
      links: [{ feedbackId: 990000256, taskId: 't_open' }],
      rows: [{ id: 990000256, status: 'actioned', handledById: HUMAN, hqTaskId: null }],
    });
    await runFeedbackHqSync(d);
    expect(calls).toEqual([
      { id: 990000256, status: 'actioned', expectedStatus: 'actioned', hqTaskUrl: url('t_open') },
    ]);
  });

  it('never replaces a link the row already holds for a different task', async () => {
    const { d, calls } = deps({
      links: [{ feedbackId: 990000257, taskId: 't_cluster' }],
      rows: [{ id: 990000257, status: 'new', handledById: null, hqTaskId: 't_intake' }],
      tasks: { t_cluster: open },
    });
    await runFeedbackHqSync(d);
    expect(calls).toEqual([{ id: 990000257, status: 'reviewed', expectedStatus: 'new' }]);
  });

  it('counts a compare-and-set refusal as a conflict and moves on', async () => {
    const { d, calls, counted } = deps({
      links: [
        { feedbackId: 990000260, taskId: 't_open' },
        { feedbackId: 990000261, taskId: 't_open' },
      ],
      rows: [
        { id: 990000260, status: 'new', handledById: null, hqTaskId: null },
        { id: 990000261, status: 'new', handledById: null, hqTaskId: null },
      ],
      tasks: { t_open: open },
      triage: (call) => (call.id === 990000260 ? 'conflict' : 'changed'),
    });
    const summary = await runFeedbackHqSync(d);
    expect(calls.map((c) => c.id)).toEqual([990000260, 990000261]);
    expect(counted).toMatchObject({ conflict: 1, moved_reviewed: 1 });
    expect(summary).toMatchObject({ conflicts: 1, moved: { reviewed: 1 } });
  });
});

describe('runFeedbackHqSync: a moderator acting mid-run', () => {
  it('scopes every write on the handler it read, so a row a moderator took over is refused', async () => {
    const { d, handlers } = deps({
      links: [
        { feedbackId: 990000301, taskId: 't_no' },
        { feedbackId: 990000302, taskId: 't_open' },
        { feedbackId: 990000303, taskId: 't_done' },
      ],
      rows: [
        { id: 990000301, status: 'reviewed', handledById: ACTOR, hqTaskId: 't_no' },
        { id: 990000302, status: 'new', handledById: null, hqTaskId: null },
        { id: 990000303, status: 'reviewed', handledById: HUMAN, hqTaskId: 't_done' },
      ],
      tasks: { t_no: wontfix, t_open: open, t_done: complete },
    });
    await runFeedbackHqSync(d);
    // New rows are worked first: the new row on no handler, then the dismiss on the sync's own,
    // then the actioned on the moderator's.
    expect(handlers).toEqual([null, ACTOR, HUMAN]);
  });

  it('counts the refusal when a moderator re-stamped the row between the read and the dismiss', async () => {
    const { d, calls, counted } = deps({
      links: [{ feedbackId: 990000304, taskId: 't_no' }],
      rows: [{ id: 990000304, status: 'reviewed', handledById: ACTOR, hqTaskId: 't_no' }],
      tasks: { t_no: wontfix },
      // The shared write's answer when the handler no longer matches.
      triage: () => 'conflict',
    });
    const summary = await runFeedbackHqSync(d);
    expect(calls).toEqual([{ id: 990000304, status: 'dismissed', expectedStatus: 'reviewed' }]);
    expect(counted).toMatchObject({ conflict: 1 });
    expect(summary.moved.dismissed).toBe(0);
  });
});

describe('runFeedbackHqSync: the area cross-check', () => {
  it('skips a row whose area is not the one HQ recorded, and counts it', async () => {
    const { d, calls, reads, counted } = deps({
      links: [
        { feedbackId: 990000311, taskId: 't_open', area: 'site-bug-report' },
        { feedbackId: 990000312, taskId: 't_open' },
      ],
      rows: [
        { id: 990000311, area: 'apps-platform', status: 'new', handledById: null, hqTaskId: null },
        { id: 990000312, status: 'new', handledById: null, hqTaskId: null },
      ],
      tasks: { t_open: open },
    });
    const summary = await runFeedbackHqSync(d);
    expect(calls.map((c) => c.id)).toEqual([990000312]);
    expect(reads).toEqual(['t_open']);
    expect(counted).toMatchObject({ area_mismatch: 1 });
    expect(summary.areaMismatches).toBe(1);
  });

  it('skips a link that carries no area at all', async () => {
    const { d, calls, counted } = deps({
      rows: [{ id: 990000313, status: 'new', handledById: null, hqTaskId: null }],
      tasks: { t_open: open },
    });
    d.listLinks = vi.fn(async () => ({
      links: [{ feedbackId: 990000313, taskId: 't_open' }],
      truncated: false,
    }));
    await runFeedbackHqSync(d);
    expect(calls).toEqual([]);
    expect(counted).toMatchObject({ area_mismatch: 1 });
  });
});

describe('runFeedbackHqSync: a bounded run', () => {
  const twoRows = {
    links: [
      { feedbackId: 990000321, taskId: 't_a' },
      { feedbackId: 990000322, taskId: 't_b' },
    ],
    rows: [
      { id: 990000321, status: 'new', handledById: null, hqTaskId: null },
      { id: 990000322, status: 'new', handledById: null, hqTaskId: null },
    ],
    tasks: { t_a: open, t_b: open },
  };

  it('stops at the task-read cap, writes nothing past it, and counts the early stop', async () => {
    const { d, calls, reads, counted } = deps({ ...twoRows, maxTaskReads: 1 });
    const summary = await runFeedbackHqSync(d);
    expect(reads).toEqual(['t_a']);
    expect(calls.map((c) => c.id)).toEqual([990000321]);
    expect(summary.stoppedEarly).toBe('task_cap');
    expect(counted).toMatchObject({ stopped_early: 1 });
  });

  it('stops at the deadline', async () => {
    let now = 1_000;
    const { d, calls, counted } = deps({
      ...twoRows,
      deadlineMs: 50,
      // Each read of the clock moves it 30 ms on: the second row starts past the deadline.
      clock: () => (now += 30),
    });
    const summary = await runFeedbackHqSync(d);
    expect(calls.map((c) => c.id)).toEqual([990000321]);
    expect(summary.stoppedEarly).toBe('deadline');
    expect(counted).toMatchObject({ stopped_early: 1 });
  });

  it('does not stop early when the run fits', async () => {
    const { d, calls, counted } = deps({ ...twoRows, maxTaskReads: 2, deadlineMs: 60_000 });
    const summary = await runFeedbackHqSync(d);
    expect(calls).toHaveLength(2);
    expect(summary.stoppedEarly).toBeNull();
    expect(counted.stopped_early ?? 0).toBe(0);
  });

  it('works the new rows first, so a cap never starves them behind reviewed ones', async () => {
    const { d, calls } = deps({
      links: [
        { feedbackId: 990000331, taskId: 't_a' },
        { feedbackId: 990000332, taskId: 't_b' },
      ],
      rows: [
        { id: 990000331, status: 'reviewed', handledById: ACTOR, hqTaskId: 't_a' },
        { id: 990000332, status: 'new', handledById: null, hqTaskId: null },
      ],
      tasks: { t_a: complete, t_b: open },
      maxTaskReads: 1,
    });
    await runFeedbackHqSync(d);
    expect(calls.map((c) => c.id)).toEqual([990000332]);
  });
});

describe('runFeedbackHqSync: HQ failures', () => {
  it('skips the rows whose task could not be read and carries on with the rest', async () => {
    const { d, calls, counted } = deps({
      links: [
        { feedbackId: 990000270, taskId: 't_broken' },
        { feedbackId: 990000271, taskId: 't_open' },
      ],
      rows: [
        { id: 990000270, status: 'new', handledById: null, hqTaskId: null },
        { id: 990000271, status: 'new', handledById: null, hqTaskId: null },
      ],
      tasks: { t_broken: new Error('HQ answered 502'), t_open: open },
    });
    const summary = await runFeedbackHqSync(d);
    expect(calls).toEqual([
      { id: 990000271, status: 'reviewed', expectedStatus: 'new', hqTaskUrl: url('t_open') },
    ]);
    expect(counted).toMatchObject({ hq_read_failed: 1, moved_reviewed: 1 });
    expect(summary.hqReadFailures).toBe(1);
  });

  it('writes nothing when the link list cannot be read, and does not throw', async () => {
    const { d, calls, counted } = deps({});
    d.listLinks = vi.fn(async () => {
      throw new Error('HQ answered 503');
    });
    const summary = await runFeedbackHqSync(d);
    expect(calls).toEqual([]);
    expect(d.readRows).not.toHaveBeenCalled();
    expect(counted).toMatchObject({ hq_read_failed: 1 });
    expect(summary.hqReadFailures).toBe(1);
  });

  it('reads each task once however many rows it covers', async () => {
    const { d, reads } = deps({
      links: [
        { feedbackId: 990000280, taskId: 't_open' },
        { feedbackId: 990000281, taskId: 't_open' },
      ],
      rows: [
        { id: 990000280, status: 'new', handledById: null, hqTaskId: null },
        { id: 990000281, status: 'new', handledById: null, hqTaskId: null },
      ],
      tasks: { t_open: open },
    });
    await runFeedbackHqSync(d);
    expect(reads).toEqual(['t_open']);
  });

  it('leaves the status alone when a merge cannot be followed, and still records the link', async () => {
    const { d, calls, counted } = deps({
      links: [{ feedbackId: 990000290, taskId: 't_dup' }],
      rows: [{ id: 990000290, status: 'new', handledById: null, hqTaskId: null }],
      tasks: { t_dup: { ...wontfix, merged_into: 't_hidden' } },
    });
    await runFeedbackHqSync(d);
    expect(calls).toEqual([
      { id: 990000290, status: 'new', expectedStatus: 'new', hqTaskUrl: url('t_dup') },
    ]);
    expect(counted).toMatchObject({ unresolved: 1 });
  });

  it.each([
    ['a path-shaped id', '../people'],
    ['an upper-case id', 'T_UPPER'],
  ])('neither reads nor writes for a link whose task id is %s', async (_label, taskId) => {
    const { d, calls, reads, counted } = deps({
      links: [{ feedbackId: 990000291, taskId }],
      rows: [{ id: 990000291, status: 'new', handledById: null, hqTaskId: null }],
      tasks: { [taskId]: open },
    });
    const summary = await runFeedbackHqSync(d);
    expect(calls).toEqual([]);
    expect(reads).toEqual([]);
    expect(summary.unresolved).toBe(1);
    expect(counted).toMatchObject({ unresolved: 1 });
  });
});

describe('runFeedbackHqSyncGuarded: preconditions', () => {
  const log = vi.fn();
  beforeEach(() => log.mockReset());

  it('is a no-op while the flag is off, reading nothing', async () => {
    const make = vi.fn();
    expect(
      await runFeedbackHqSyncGuarded({
        flagOn: async () => false,
        token: 'hq_x',
        actorId: ACTOR,
        make,
        log,
      })
    ).toEqual({ skipped: 'flag-off' });
    expect(make).not.toHaveBeenCalled();
  });

  it('is a no-op without a token, and says so once per process', async () => {
    const make = vi.fn();
    const args = { flagOn: async () => true, token: undefined, actorId: ACTOR, make, log };
    expect(await runFeedbackHqSyncGuarded(args)).toEqual({ skipped: 'no-token' });
    expect(await runFeedbackHqSyncGuarded(args)).toEqual({ skipped: 'no-token' });
    expect(make).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('is a no-op without an acting account', async () => {
    const make = vi.fn();
    expect(
      await runFeedbackHqSyncGuarded({
        flagOn: async () => true,
        token: 'hq_x',
        actorId: undefined,
        make,
        log,
      })
    ).toEqual({ skipped: 'no-actor' });
    expect(make).not.toHaveBeenCalled();
  });
});

describe('createHqFeedbackReader', () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it('pages through the linked feedback items with the token, and drops rows without a task', async () => {
    const seen: { url: string; auth: string | null; redirect: RequestRedirect | undefined }[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(input));
      seen.push({
        url: u.pathname + u.search,
        auth: new Headers(init?.headers).get('authorization'),
        redirect: init?.redirect,
      });
      return u.searchParams.get('cursor')
        ? ok({ rows: [{ id: 'fb-3', feedback_id: 3, task: 't_c', area: 'app-block' }] })
        : ok({
            rows: [
              { id: 'fb-1', feedback_id: 1, task: 't_a', area: 'apps-platform' },
              { id: 'fb-2', feedback_id: 2 },
            ],
            next: 'CUR',
          });
    });
    const reader = createHqFeedbackReader({ token: 'hq_secret', fetch: fetchFn as typeof fetch });
    expect(await reader.listLinks()).toEqual({
      links: [
        { feedbackId: 1, taskId: 't_a', area: 'apps-platform' },
        { feedbackId: 3, taskId: 't_c', area: 'app-block' },
      ],
      truncated: false,
    });
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.auth === 'Bearer hq_secret')).toBe(true);
    // A redirect would replay the token to wherever it points.
    expect(seen.every((s) => s.redirect === 'error')).toBe(true);
    expect(seen[0].url.startsWith('/api/v1/data/feedback_items?')).toBe(true);
    expect(seen[1].url).toContain('cursor=CUR');
    expect(seen[0].url).toContain('fields=feedback_id,task,area');
  });

  it('reads a task row, answers null for one HQ does not show, and throws on a server error', async () => {
    const redirects: (RequestRedirect | undefined)[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      redirects.push(init?.redirect);
      const path = new URL(String(input)).pathname;
      if (path === '/api/v1/data/tasks/t_a')
        return ok({
          id: 't_a',
          status: 'wontfix',
          closed: '2026-11-12T19:08:53Z',
          merged_into: 't_b',
        });
      if (path === '/api/v1/data/tasks/t_missing') return new Response('{}', { status: 404 });
      return new Response('down', { status: 502 });
    });
    const reader = createHqFeedbackReader({ token: 'hq_secret', fetch: fetchFn as typeof fetch });
    expect(await reader.readTask('t_a')).toEqual({
      status: 'wontfix',
      closed: '2026-11-12T19:08:53Z',
      merged_into: 't_b',
    });
    expect(await reader.readTask('t_missing')).toBeNull();
    await expect(reader.readTask('t_down')).rejects.toThrow('502');
    expect(redirects).toEqual(['error', 'error', 'error']);
  });

  it('works the links it read when HQ holds more pages than one run reads, and counts the cut', async () => {
    const pages: number[] = [];
    // Every page names one more link and offers a next page, for twice as many pages as one run
    // reads: a broken cap then fails on the page count instead of looping forever.
    const offered = MAX_PAGES * 2;
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const page = Number(new URL(String(input)).searchParams.get('cursor') ?? 0);
      pages.push(page);
      return ok({
        rows: [{ feedback_id: 990000400 + page, task: 't_open', area: AREA }],
        ...(page + 1 < offered ? { next: String(page + 1) } : {}),
      });
    });
    const lastRead = 990000400 + MAX_PAGES - 1;
    const reader = createHqFeedbackReader({ token: 'hq_secret', fetch: fetchFn as typeof fetch });
    const { d, calls, counted } = deps({
      rows: [
        { id: 990000400, status: 'new', handledById: null, hqTaskId: null },
        { id: lastRead, status: 'new', handledById: null, hqTaskId: null },
        // Named only on a page past the cut: not visited.
        { id: lastRead + 1, status: 'new', handledById: null, hqTaskId: null },
      ],
      tasks: { t_open: open },
    });
    d.listLinks = reader.listLinks;
    const summary = await runFeedbackHqSync(d);
    expect(pages).toHaveLength(MAX_PAGES);
    expect(calls.map((c) => c.id)).toEqual([990000400, lastRead]);
    expect(summary).toMatchObject({ links: MAX_PAGES, linksTruncated: true, hqReadFailures: 0 });
    expect(counted).toMatchObject({ links_truncated: 1, moved_reviewed: 2 });
    expect(counted.hq_read_failed ?? 0).toBe(0);
  });

  it('refuses to request a task id that is not id-shaped', async () => {
    const fetchFn = vi.fn();
    const reader = createHqFeedbackReader({ token: 'hq_secret', fetch: fetchFn as typeof fetch });
    await expect(reader.readTask('../people')).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
