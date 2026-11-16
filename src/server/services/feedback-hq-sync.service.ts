import type { FeedbackTriageRequest } from '@civitai/moderation';
import { HQ_TASK_URL_PREFIX, hqTaskFromUrl } from '@civitai/shared/clickup-url';
import type { FeedbackTriageStatus } from '@civitai/shared/feedback.constants';
import type { FeedbackHqSyncEvent } from '~/server/prom/feedback-hq-sync.metrics';
import type { FeedbackTriageOutcome } from '~/server/services/feedback-triage.service';

/**
 * The feedback ↔ HQ status sync: a feedback row's moderator triage status follows the HQ task it
 * was filed under. The link is HQ's `feedback_items` collection (one row per feedback id, with the
 * `task` the triager filed or attached it to); the outcome is that task's own status.
 *
 *   task open (not closed)             → reviewed
 *   task complete                      → actioned
 *   task wontfix, not merged           → dismissed
 *   task wontfix, `merged_into` <id>   → whatever <id> maps to (at most MAX_MERGE_HOPS)
 *   anything else (a hidden or missing task, a done status this does not know, a merge chain too
 *   long or circular)                  → no status change, logged and counted as `unresolved`
 *
 * 🔴 FORWARD ONLY, AND ONLY OVER ITS OWN VERDICTS. A row moves new → reviewed → actioned/dismissed and
 * never back. A row a moderator set (`handledById` is not the sync's own account) is never moved:
 * the sync's job is to stop rows sitting at `new`, not to second-guess a person. A terminal row
 * (actioned/dismissed) is never moved either, whoever set it. Every write is the queue's own
 * compare-and-set triage write, scoped on the status read a moment before, so a row that moved in
 * between is refused rather than overwritten.
 *
 * The HQ link is recorded as `context.hq` on any row that has none, as an annotate-only write that
 * leaves the status and who set it alone. A row that already holds a DIFFERENT task (a site bug
 * report's intake task, later attached to a cluster task) keeps its link; its status follows the
 * `feedback_items` task.
 *
 * ⚠️ NOT COVERED: a moderator moving a row back to `new` clears its handler, so the next run moves it
 * to `reviewed` again. Nothing distinguishes that row from one never triaged.
 */

export const MAX_MERGE_HOPS = 3;

export type HqTaskRow = { status: string; closed?: string | null; merged_into?: string | null };

export type FeedbackSyncRow = {
  id: number;
  status: string;
  handledById: number | null;
  /** `context.hq.id`, or null when the row records no HQ task. */
  hqTaskId: string | null;
};

type SyncStatus = Exclude<FeedbackTriageStatus, 'new'>;
export type TaskTarget =
  | { status: SyncStatus; followed?: string[] }
  | { unresolved: 'task_missing' | 'unknown_done_status' | 'merge_too_deep' };

export type SyncDeps = {
  listLinks: () => Promise<{ feedbackId: number; taskId: string }[]>;
  readRows: (ids: number[]) => Promise<FeedbackSyncRow[]>;
  /** null: HQ does not show the task. Throws on any other failure. */
  readTask: (id: string) => Promise<HqTaskRow | null>;
  triage: (request: FeedbackTriageRequest) => Promise<FeedbackTriageOutcome>;
  /** The account the sync's writes are attributed to. */
  actorId: number;
  count: (event: FeedbackHqSyncEvent, n?: number) => void;
  log: (data: Record<string, unknown>) => void;
};

export type SyncSummary = {
  links: number;
  rows: number;
  moved: Record<SyncStatus, number>;
  stamped: number;
  conflicts: number;
  gone: number;
  humanSet: number;
  unresolved: number;
  hqReadFailures: number;
  writeFailures: number;
};

const RANK: Record<string, number> = { new: 0, reviewed: 1, actioned: 2, dismissed: 2 };
const TASK_ID = /^[a-z0-9_-]{1,100}$/;

/** `hq:<id>` and `<id>` name the same task; anything not id-shaped is no task. */
const bareTaskId = (value: string) => {
  const id = value.startsWith('hq:') ? value.slice(3) : value;
  return TASK_ID.test(id) ? id : null;
};

/** What a task's outcome means for a feedback row, following merges. Throws when a read throws. */
export async function resolveTaskTarget(
  taskId: string,
  readTask: (id: string) => Promise<HqTaskRow | null>
): Promise<TaskTarget> {
  const followed: string[] = [];
  const seen = new Set<string>();
  let id = taskId;
  for (;;) {
    seen.add(id);
    const task = await readTask(id);
    if (!task) return { unresolved: 'task_missing' };
    const done = (status: SyncStatus): TaskTarget =>
      followed.length ? { status, followed } : { status };
    if (!task.closed) return done('reviewed');
    if (task.status === 'complete') return done('actioned');
    if (task.status !== 'wontfix') return { unresolved: 'unknown_done_status' };
    if (!task.merged_into) return done('dismissed');
    const next = bareTaskId(task.merged_into);
    if (!next) return { unresolved: 'task_missing' };
    if (followed.length >= MAX_MERGE_HOPS || seen.has(next))
      return { unresolved: 'merge_too_deep' };
    followed.push(next);
    id = next;
  }
}

export async function runFeedbackHqSync(deps: SyncDeps): Promise<SyncSummary> {
  const summary: SyncSummary = {
    links: 0,
    rows: 0,
    moved: { reviewed: 0, actioned: 0, dismissed: 0 },
    stamped: 0,
    conflicts: 0,
    gone: 0,
    humanSet: 0,
    unresolved: 0,
    hqReadFailures: 0,
    writeFailures: 0,
  };

  let links: { feedbackId: number; taskId: string }[];
  try {
    links = await deps.listLinks();
  } catch (error) {
    summary.hqReadFailures++;
    deps.count('hq_read_failed');
    deps.log({ type: 'error', step: 'list-links', message: (error as Error).message });
    return summary;
  }

  // One task per feedback row: the first link wins, as HQ keys `feedback_items` on the feedback id.
  const taskFor = new Map<number, string>();
  for (const link of links)
    if (!taskFor.has(link.feedbackId)) taskFor.set(link.feedbackId, link.taskId);
  summary.links = taskFor.size;
  if (!taskFor.size) return summary;

  const rows = await deps.readRows([...taskFor.keys()]);
  summary.rows = rows.length;

  const targets = new Map<string, TaskTarget | 'failed'>();
  const targetFor = async (taskId: string) => {
    const cached = targets.get(taskId);
    if (cached) return cached;
    let target: TaskTarget | 'failed';
    try {
      target = await resolveTaskTarget(taskId, deps.readTask);
    } catch (error) {
      target = 'failed';
      summary.hqReadFailures++;
      deps.count('hq_read_failed');
      deps.log({ type: 'error', step: 'read-task', taskId, message: (error as Error).message });
    }
    targets.set(taskId, target);
    return target;
  };

  const write = async (
    row: FeedbackSyncRow,
    request: FeedbackTriageRequest,
    onChanged: () => void
  ) => {
    let outcome: FeedbackTriageOutcome;
    try {
      outcome = await deps.triage(request);
    } catch (error) {
      summary.writeFailures++;
      deps.count('write_failed');
      deps.log({
        type: 'error',
        step: 'triage',
        feedbackId: row.id,
        message: (error as Error).message,
      });
      return;
    }
    if (outcome === 'changed') onChanged();
    else if (outcome === 'conflict') {
      summary.conflicts++;
      deps.count('conflict');
    } else {
      summary.gone++;
      deps.count('gone');
    }
  };

  const stamp = (row: FeedbackSyncRow, hqTaskUrl: string) =>
    write(
      row,
      {
        id: row.id,
        status: row.status as FeedbackTriageStatus,
        expectedStatus: row.status as FeedbackTriageStatus,
        hqTaskUrl,
      },
      () => {
        summary.stamped++;
        deps.count('stamped');
      }
    );

  for (const row of rows) {
    const taskId = taskFor.get(row.id);
    if (!taskId || !(row.status in RANK)) continue;
    const link = hqTaskFromUrl(`${HQ_TASK_URL_PREFIX}${taskId}`);
    if (!link) {
      summary.unresolved++;
      deps.count('unresolved');
      deps.log({
        type: 'warning',
        step: 'link',
        feedbackId: row.id,
        reason: 'task id not id-shaped',
      });
      continue;
    }
    const stampable = row.hqTaskId === null;

    const terminal = RANK[row.status] === 2;
    const humanSet = row.status !== 'new' && row.handledById !== deps.actorId;
    if (terminal || humanSet) {
      if (humanSet) {
        summary.humanSet++;
        deps.count('human_set');
      }
      if (stampable) await stamp(row, link.url);
      continue;
    }

    const target = await targetFor(taskId);
    if (target === 'failed') continue;
    if ('unresolved' in target) {
      summary.unresolved++;
      deps.count('unresolved');
      deps.log({
        type: 'warning',
        step: 'resolve',
        feedbackId: row.id,
        taskId,
        reason: target.unresolved,
      });
      if (stampable) await stamp(row, link.url);
      continue;
    }
    if (target.followed) deps.count('merge_followed');

    if (RANK[target.status] > RANK[row.status]) {
      const to = target.status;
      await write(
        row,
        {
          id: row.id,
          status: to,
          expectedStatus: row.status as FeedbackTriageStatus,
          ...(stampable ? { hqTaskUrl: link.url } : {}),
        },
        () => {
          summary.moved[to]++;
          deps.count(`moved_${to}`);
        }
      );
    } else if (stampable) await stamp(row, link.url);
  }

  return summary;
}

const loggedOnce = new Set<string>();

/**
 * The job's entry: a no-op while the flag is off, and while the token or the acting account is
 * unset — each said once per process, so the job can deploy before its secret exists without
 * filling the log.
 */
export async function runFeedbackHqSyncGuarded({
  flagOn,
  token,
  actorId,
  make,
  log,
}: {
  flagOn: () => Promise<boolean>;
  token: string | undefined;
  actorId: number | undefined;
  make: (token: string, actorId: number) => SyncDeps;
  log: (data: Record<string, unknown>) => void;
}): Promise<SyncSummary | { skipped: 'flag-off' | 'no-token' | 'no-actor' }> {
  if (!(await flagOn())) return { skipped: 'flag-off' };
  const skip = (reason: 'no-token' | 'no-actor', message: string) => {
    if (!loggedOnce.has(reason)) {
      loggedOnce.add(reason);
      log({ type: 'warning', step: 'preconditions', reason, message });
    }
    return { skipped: reason };
  };
  if (!token) return skip('no-token', 'HQ_FEEDBACK_SYNC_TOKEN is unset; the sync does nothing.');
  if (!actorId)
    return skip('no-actor', 'CIVITAI_MODERATION_USER_ID is unset; the sync does nothing.');
  return runFeedbackHqSync(make(token, actorId));
}

const HQ_ORIGIN = 'https://hq.civitai.com';
const HQ_TIMEOUT_MS = 10_000;
const PAGE_LIMIT = 200;
const MAX_PAGES = 25;

/** HQ reads with a `read`-scoped token: the linked feedback items, and one task at a time. */
export function createHqFeedbackReader({
  token,
  fetch: doFetch = fetch,
  origin = HQ_ORIGIN,
}: {
  token: string;
  fetch?: typeof fetch;
  origin?: string;
}): Pick<SyncDeps, 'listLinks' | 'readTask'> {
  const get = (path: string) =>
    doFetch(`${origin}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      // A redirect would replay the token to wherever it points.
      redirect: 'error',
      signal: AbortSignal.timeout(HQ_TIMEOUT_MS),
    });

  return {
    async listLinks() {
      const where = encodeURIComponent(JSON.stringify({ task: { not: null } }));
      const links: { feedbackId: number; taskId: string }[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await get(
          `/api/v1/data/feedback_items?where=${where}&fields=feedback_id,task&limit=${PAGE_LIMIT}${
            cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
          }`
        );
        if (!res.ok) throw new Error(`HQ answered ${res.status} listing feedback items`);
        const body = (await res.json()) as { rows?: unknown[]; next?: unknown };
        for (const row of body.rows ?? []) {
          const { feedback_id, task } = (row ?? {}) as { feedback_id?: unknown; task?: unknown };
          if (Number.isInteger(feedback_id) && typeof task === 'string' && task)
            links.push({ feedbackId: feedback_id as number, taskId: task });
        }
        if (typeof body.next !== 'string' || !body.next) return links;
        cursor = body.next;
      }
      throw new Error(`more than ${MAX_PAGES} pages of feedback items`);
    },

    async readTask(id) {
      if (!TASK_ID.test(id)) throw new Error('not an HQ task id');
      const res = await get(`/api/v1/data/tasks/${id}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HQ answered ${res.status} reading a task`);
      const body = (await res.json()) as Record<string, unknown>;
      if (typeof body.status !== 'string') throw new Error('HQ task without a status');
      return {
        status: body.status,
        closed: typeof body.closed === 'string' ? body.closed : undefined,
        merged_into: typeof body.merged_into === 'string' ? body.merged_into : undefined,
      };
    },
  };
}
