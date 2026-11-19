import type { FeedbackTriageRequest } from '@civitai/moderation';
import {
  HQ_ORIGIN,
  HQ_TASK_ID_PATTERN,
  HQ_TASK_URL_PREFIX,
  hqTaskFromUrl,
} from '@civitai/shared/clickup-url';
import type { FeedbackTriageStatus } from '@civitai/shared/feedback.constants';
import type { FeedbackHqSyncEvent } from '~/server/prom/feedback-hq-sync.metrics';
import type { FeedbackTriageOutcome } from '~/server/services/feedback-triage.service';
import { fetchTimeoutSignal } from '~/server/utils/fetch-timeout';

/**
 * The feedback ↔ HQ status sync: a feedback row's moderator triage status follows the HQ task it
 * was filed under. The link is HQ's `feedback_items` collection (one row per feedback id, with the
 * `task` the triager filed or attached it to); the outcome is that task's own status.
 *
 *   task open (not closed)             → reviewed
 *   task complete                      → actioned
 *   task wontfix, not merged           → dismissed
 *   task wontfix, `merged_into` <id>   → whatever <id> maps to (ONE hop)
 *   anything else (a hidden or missing task, a done status this does not know, a merge target
 *   that is itself merged)             → no status change, logged and counted as `unresolved`
 *
 * 🔴 FORWARD ONLY. A row moves new → reviewed → actioned/dismissed and never back, and a terminal row
 * (actioned/dismissed) is never moved, whoever set it.
 *
 * 🔴 IT NEVER DISMISSES A PERSON'S VERDICT. A `reviewed` row moves to `actioned` when its task (or the
 * task it was merged into) completes, whoever reviewed it: a completed task is a fact about the work.
 * It moves to `dismissed` only when the sync's own account reviewed it; a row a moderator reviewed
 * (`handledById` is anyone else) stays `reviewed` under a wontfix task, because a wontfix can mean
 * "duplicate of something HQ cannot point at", which only the moderator can judge (counted as
 * `human_set`). Every write is the queue's own
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

export const MAX_MERGE_HOPS = 1;
/**
 * One run's bounds, well inside the job's 10-minute lock: a run past either stops where it is,
 * counts `stopped_early`, and the next run (15 minutes on) starts over. Rows at `new` are worked
 * first, so a cap can delay a `reviewed` row's advance but never leave a new row unseen behind it.
 */
export const RUN_DEADLINE_MS = 5 * 60_000;
export const MAX_TASK_READS_PER_RUN = 500;

export type HqTaskRow = { status: string; closed?: string | null; merged_into?: string | null };

export type FeedbackSyncRow = {
  id: number;
  /** `Feedback.area`, checked against the area HQ recorded for the link. */
  area: string;
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
  /** `truncated`: HQ held more links than one run reads; the rest are not visited this run. */
  listLinks: () => Promise<{ links: HqFeedbackLink[]; truncated: boolean }>;
  readRows: (ids: number[]) => Promise<FeedbackSyncRow[]>;
  /** null: HQ does not show the task. Throws on any other failure. */
  readTask: (id: string) => Promise<HqTaskRow | null>;
  /** The shared triage write, scoped on the status AND the handler the sync read. */
  triage: (
    request: FeedbackTriageRequest & { expectedHandledById: number | null }
  ) => Promise<FeedbackTriageOutcome>;
  /** The account the sync's writes are attributed to. */
  actorId: number;
  count: (event: FeedbackHqSyncEvent, n?: number) => void;
  log: (data: Record<string, unknown>) => void;
  /** Defaults: `Date.now`, RUN_DEADLINE_MS, MAX_TASK_READS_PER_RUN. */
  clock?: () => number;
  deadlineMs?: number;
  maxTaskReads?: number;
};

export type HqFeedbackLink = { feedbackId: number; taskId: string; area?: string };

export type SyncSummary = {
  links: number;
  /** HQ held more links than one run reads (MAX_PAGES); only those read were worked. */
  linksTruncated: boolean;
  rows: number;
  moved: Record<SyncStatus, number>;
  stamped: number;
  conflicts: number;
  gone: number;
  humanSet: number;
  unresolved: number;
  hqReadFailures: number;
  writeFailures: number;
  areaMismatches: number;
  /** Why the run stopped before its last row, or null when it did not. */
  stoppedEarly: 'deadline' | 'task_cap' | null;
};

const RANK: Record<string, number> = { new: 0, reviewed: 1, actioned: 2, dismissed: 2 };

/** `hq:<id>` and `<id>` name the same task; anything not id-shaped is no task. */
const bareTaskId = (value: string) => {
  const id = value.startsWith('hq:') ? value.slice(3) : value;
  return HQ_TASK_ID_PATTERN.test(id) ? id : null;
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
    linksTruncated: false,
    rows: 0,
    moved: { reviewed: 0, actioned: 0, dismissed: 0 },
    stamped: 0,
    conflicts: 0,
    gone: 0,
    humanSet: 0,
    unresolved: 0,
    hqReadFailures: 0,
    writeFailures: 0,
    areaMismatches: 0,
    stoppedEarly: null,
  };
  const clock = deps.clock ?? Date.now;
  const deadlineMs = deps.deadlineMs ?? RUN_DEADLINE_MS;
  const maxTaskReads = deps.maxTaskReads ?? MAX_TASK_READS_PER_RUN;
  const startedAt = clock();

  let links: HqFeedbackLink[];
  try {
    const listed = await deps.listLinks();
    links = listed.links;
    summary.linksTruncated = listed.truncated;
  } catch (error) {
    summary.hqReadFailures++;
    deps.count('hq_read_failed');
    deps.log({ type: 'error', step: 'list-links', message: (error as Error).message });
    return summary;
  }
  // 🔴 A truncated list is SAFE to work: a row is only ever read and written because a link names
  // it, so a row whose link was not read this run is simply not visited — its absence drives no
  // write. Counted, because the links past the cut are the same ones every run while HQ's order
  // holds, and they would then never be worked.
  if (summary.linksTruncated) {
    deps.count('links_truncated');
    deps.log({ type: 'warning', step: 'list-links', truncated: true, read: links.length });
  }

  // One task per feedback row: the first link wins, as HQ keys `feedback_items` on the feedback id.
  const linkFor = new Map<number, HqFeedbackLink>();
  for (const link of links) if (!linkFor.has(link.feedbackId)) linkFor.set(link.feedbackId, link);
  summary.links = linkFor.size;
  if (!linkFor.size) return summary;

  const read = await deps.readRows([...linkFor.keys()]);
  summary.rows = read.length;
  // New rows first (stable otherwise): see RUN_DEADLINE_MS.
  const rows = [
    ...read.filter((r) => r.status === 'new'),
    ...read.filter((r) => r.status !== 'new'),
  ];

  let taskReads = 0;
  const readTask = (id: string) => {
    taskReads++;
    return deps.readTask(id);
  };

  const targets = new Map<string, TaskTarget | 'failed'>();
  const targetFor = async (taskId: string) => {
    const cached = targets.get(taskId);
    if (cached) return cached;
    let target: TaskTarget | 'failed';
    try {
      target = await resolveTaskTarget(taskId, readTask);
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
      // 🔴 Scoped on the handler read at the start of the run as well as the status: a moderator's
      // same-status save re-stamps `handledById` without moving the status, and the sync must not
      // then act on a "sync-set" row that is now the moderator's (above all: dismiss it).
      outcome = await deps.triage({ ...request, expectedHandledById: row.handledById });
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
    if (clock() - startedAt > deadlineMs) {
      summary.stoppedEarly = 'deadline';
      break;
    }
    const entry = linkFor.get(row.id);
    if (!entry || !(row.status in RANK)) continue;
    const taskId = entry.taskId;
    // The link must be about this row: a feedback id HQ recorded under another area is a stale or
    // mistyped link, and acting on it would write a verdict onto someone else's report.
    if (entry.area !== row.area) {
      summary.areaMismatches++;
      deps.count('area_mismatch');
      deps.log({
        type: 'warning',
        step: 'area',
        feedbackId: row.id,
        linkArea: entry.area ?? null,
        area: row.area,
      });
      continue;
    }
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

    if (RANK[row.status] === 2) {
      if (stampable) await stamp(row, link.url);
      continue;
    }

    if (!targets.has(taskId) && taskReads >= maxTaskReads) {
      summary.stoppedEarly = 'task_cap';
      break;
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

    const humanReviewed = row.status === 'reviewed' && row.handledById !== deps.actorId;
    if (humanReviewed && target.status === 'dismissed') {
      summary.humanSet++;
      deps.count('human_set');
      if (stampable) await stamp(row, link.url);
    } else if (RANK[target.status] > RANK[row.status]) {
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

  if (summary.stoppedEarly) {
    deps.count('stopped_early');
    deps.log({ type: 'warning', step: 'run', stoppedEarly: summary.stoppedEarly, taskReads });
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

const HQ_TIMEOUT_MS = 10_000;
const PAGE_LIMIT = 200;
/** Pages of links one run reads; a list longer than this is worked up to it (`links_truncated`). */
export const MAX_PAGES = 25;

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
      signal: fetchTimeoutSignal(HQ_TIMEOUT_MS),
    });

  return {
    async listLinks() {
      const where = encodeURIComponent(JSON.stringify({ task: { not: null } }));
      const links: HqFeedbackLink[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await get(
          `/api/v1/data/feedback_items?where=${where}&fields=feedback_id,task,area&limit=${PAGE_LIMIT}${
            cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
          }`
        );
        if (!res.ok) throw new Error(`HQ answered ${res.status} listing feedback items`);
        const body = (await res.json()) as { rows?: unknown[]; next?: unknown };
        for (const row of body.rows ?? []) {
          const { feedback_id, task, area } = (row ?? {}) as {
            feedback_id?: unknown;
            task?: unknown;
            area?: unknown;
          };
          if (Number.isInteger(feedback_id) && typeof task === 'string' && task)
            links.push({
              feedbackId: feedback_id as number,
              taskId: task,
              area: typeof area === 'string' ? area : undefined,
            });
        }
        if (typeof body.next !== 'string' || !body.next) return { links, truncated: false };
        cursor = body.next;
      }
      return { links, truncated: true };
    },

    async readTask(id) {
      if (!HQ_TASK_ID_PATTERN.test(id)) throw new Error('not an HQ task id');
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
