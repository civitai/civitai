import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHqFeedbackReader,
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

function deps(over: {
  links?: { feedbackId: number; taskId: string }[];
  rows?: FeedbackSyncRow[];
  tasks?: Record<string, HqTaskRow | null | Error>;
  triage?: (call: Call) => 'changed' | 'conflict' | 'gone';
}) {
  const calls: Call[] = [];
  const counted: Record<string, number> = {};
  const reads: string[] = [];
  const d: SyncDeps = {
    listLinks: vi.fn(async () => over.links ?? []),
    readRows: vi.fn(async (ids: number[]) => (over.rows ?? []).filter((r) => ids.includes(r.id))),
    readTask: vi.fn(async (id: string) => {
      reads.push(id);
      const t = over.tasks?.[id];
      if (t instanceof Error) throw t;
      return t === undefined ? null : t;
    }),
    triage: vi.fn(async (call: Call) => {
      calls.push(call);
      return over.triage ? over.triage(call) : 'changed';
    }),
    actorId: ACTOR,
    count: (event, n = 1) => {
      counted[event] = (counted[event] ?? 0) + n;
    },
    log: vi.fn(),
  };
  return { d, calls, counted, reads };
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

  it('stops following merges after three hops', async () => {
    const tasks = {
      a1: { ...wontfix, merged_into: 'a2' },
      a2: { ...wontfix, merged_into: 'a3' },
      a3: { ...wontfix, merged_into: 'a4' },
      a4: { ...wontfix, merged_into: 'a5' },
      a5: complete,
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
      links: [{ feedbackId: 258, taskId: 't_open' }],
      rows: [{ id: 258, status: 'new', handledById: null, hqTaskId: null }],
      tasks: { t_open: open },
    });
    await runFeedbackHqSync(d);
    expect(calls).toEqual([
      { id: 258, status: 'reviewed', expectedStatus: 'new', hqTaskUrl: url('t_open') },
    ]);
    expect(counted).toMatchObject({ moved_reviewed: 1 });
  });

  it('moves a new row straight to actioned for a completed task', async () => {
    const { d, calls } = deps({
      links: [{ feedbackId: 250, taskId: 't_done' }],
      rows: [{ id: 250, status: 'new', handledById: null, hqTaskId: null }],
      tasks: { t_done: complete },
    });
    await runFeedbackHqSync(d);
    expect(calls).toEqual([
      { id: 250, status: 'actioned', expectedStatus: 'new', hqTaskUrl: url('t_done') },
    ]);
  });

  it('advances a row IT reviewed when the task completes, and does not re-send the link', async () => {
    const { d, calls, counted } = deps({
      links: [{ feedbackId: 251, taskId: 't_done' }],
      rows: [{ id: 251, status: 'reviewed', handledById: ACTOR, hqTaskId: 't_done' }],
      tasks: { t_done: complete },
    });
    await runFeedbackHqSync(d);
    expect(calls).toEqual([{ id: 251, status: 'actioned', expectedStatus: 'reviewed' }]);
    expect(counted).toMatchObject({ moved_actioned: 1 });
  });

  it('dismisses a row it reviewed when the task is a real wontfix', async () => {
    const { d, calls, counted } = deps({
      links: [{ feedbackId: 252, taskId: 't_no' }],
      rows: [{ id: 252, status: 'reviewed', handledById: ACTOR, hqTaskId: 't_no' }],
      tasks: { t_no: wontfix },
    });
    await runFeedbackHqSync(d);
    expect(calls).toEqual([{ id: 252, status: 'dismissed', expectedStatus: 'reviewed' }]);
    expect(counted).toMatchObject({ moved_dismissed: 1 });
  });

  it('never moves a row backwards: an open task leaves a row it reviewed alone', async () => {
    const { d, calls } = deps({
      links: [{ feedbackId: 253, taskId: 't_open' }],
      rows: [{ id: 253, status: 'reviewed', handledById: ACTOR, hqTaskId: 't_open' }],
      tasks: { t_open: open },
    });
    await runFeedbackHqSync(d);
    expect(calls).toEqual([]);
  });

  it.each(['actioned', 'dismissed'])(
    'never touches a %s row, even when its task reopened, and does not read the task',
    async (status) => {
      const { d, calls, reads } = deps({
        links: [{ feedbackId: 254, taskId: 't_open' }],
        rows: [{ id: 254, status, handledById: ACTOR, hqTaskId: 't_open' }],
        tasks: { t_open: open },
      });
      await runFeedbackHqSync(d);
      expect(calls).toEqual([]);
      expect(reads).toEqual([]);
    }
  );
});

describe('runFeedbackHqSync: a status a human set', () => {
  it('leaves a row a moderator reviewed at reviewed, whatever its task says', async () => {
    const { d, calls, counted, reads } = deps({
      links: [{ feedbackId: 255, taskId: 't_no' }],
      rows: [{ id: 255, status: 'reviewed', handledById: HUMAN, hqTaskId: 't_no' }],
      tasks: { t_no: wontfix },
    });
    await runFeedbackHqSync(d);
    expect(calls).toEqual([]);
    expect(reads).toEqual([]);
    expect(counted).toMatchObject({ human_set: 1 });
  });

  it('still records the link on a human-set row that lacks one, without changing its status', async () => {
    const { d, calls } = deps({
      links: [{ feedbackId: 256, taskId: 't_open' }],
      rows: [{ id: 256, status: 'actioned', handledById: HUMAN, hqTaskId: null }],
    });
    await runFeedbackHqSync(d);
    expect(calls).toEqual([
      { id: 256, status: 'actioned', expectedStatus: 'actioned', hqTaskUrl: url('t_open') },
    ]);
  });

  it('never replaces a link the row already holds for a different task', async () => {
    const { d, calls } = deps({
      links: [{ feedbackId: 257, taskId: 't_cluster' }],
      rows: [{ id: 257, status: 'new', handledById: null, hqTaskId: 't_intake' }],
      tasks: { t_cluster: open },
    });
    await runFeedbackHqSync(d);
    expect(calls).toEqual([{ id: 257, status: 'reviewed', expectedStatus: 'new' }]);
  });

  it('counts a compare-and-set refusal as a conflict and moves on', async () => {
    const { d, calls, counted } = deps({
      links: [
        { feedbackId: 260, taskId: 't_open' },
        { feedbackId: 261, taskId: 't_open' },
      ],
      rows: [
        { id: 260, status: 'new', handledById: null, hqTaskId: null },
        { id: 261, status: 'new', handledById: null, hqTaskId: null },
      ],
      tasks: { t_open: open },
      triage: (call) => (call.id === 260 ? 'conflict' : 'changed'),
    });
    const summary = await runFeedbackHqSync(d);
    expect(calls.map((c) => c.id)).toEqual([260, 261]);
    expect(counted).toMatchObject({ conflict: 1, moved_reviewed: 1 });
    expect(summary).toMatchObject({ conflicts: 1, moved: { reviewed: 1 } });
  });
});

describe('runFeedbackHqSync: HQ failures', () => {
  it('skips the rows whose task could not be read and carries on with the rest', async () => {
    const { d, calls, counted } = deps({
      links: [
        { feedbackId: 270, taskId: 't_broken' },
        { feedbackId: 271, taskId: 't_open' },
      ],
      rows: [
        { id: 270, status: 'new', handledById: null, hqTaskId: null },
        { id: 271, status: 'new', handledById: null, hqTaskId: null },
      ],
      tasks: { t_broken: new Error('HQ answered 502'), t_open: open },
    });
    const summary = await runFeedbackHqSync(d);
    expect(calls).toEqual([
      { id: 271, status: 'reviewed', expectedStatus: 'new', hqTaskUrl: url('t_open') },
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
        { feedbackId: 280, taskId: 't_open' },
        { feedbackId: 281, taskId: 't_open' },
      ],
      rows: [
        { id: 280, status: 'new', handledById: null, hqTaskId: null },
        { id: 281, status: 'new', handledById: null, hqTaskId: null },
      ],
      tasks: { t_open: open },
    });
    await runFeedbackHqSync(d);
    expect(reads).toEqual(['t_open']);
  });

  it('leaves the status alone when a merge cannot be followed, and still records the link', async () => {
    const { d, calls, counted } = deps({
      links: [{ feedbackId: 290, taskId: 't_dup' }],
      rows: [{ id: 290, status: 'new', handledById: null, hqTaskId: null }],
      tasks: { t_dup: { ...wontfix, merged_into: 't_hidden' } },
    });
    await runFeedbackHqSync(d);
    expect(calls).toEqual([
      { id: 290, status: 'new', expectedStatus: 'new', hqTaskUrl: url('t_dup') },
    ]);
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
    const seen: { url: string; auth: string | null }[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(input));
      seen.push({
        url: u.pathname + u.search,
        auth: new Headers(init?.headers).get('authorization'),
      });
      return u.searchParams.get('cursor')
        ? ok({ rows: [{ id: 'fb-3', feedback_id: 3, task: 't_c' }] })
        : ok({
            rows: [
              { id: 'fb-1', feedback_id: 1, task: 't_a' },
              { id: 'fb-2', feedback_id: 2 },
            ],
            next: 'CUR',
          });
    });
    const reader = createHqFeedbackReader({ token: 'hq_secret', fetch: fetchFn as typeof fetch });
    expect(await reader.listLinks()).toEqual([
      { feedbackId: 1, taskId: 't_a' },
      { feedbackId: 3, taskId: 't_c' },
    ]);
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.auth === 'Bearer hq_secret')).toBe(true);
    expect(seen[0].url.startsWith('/api/v1/data/feedback_items?')).toBe(true);
    expect(seen[1].url).toContain('cursor=CUR');
  });

  it('reads a task row, answers null for one HQ does not show, and throws on a server error', async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
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
  });

  it('refuses to request a task id that is not id-shaped', async () => {
    const fetchFn = vi.fn();
    const reader = createHqFeedbackReader({ token: 'hq_secret', fetch: fetchFn as typeof fetch });
    await expect(reader.readTask('../people')).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
