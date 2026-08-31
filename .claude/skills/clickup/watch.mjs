#!/usr/bin/env node

/**
 * watch.mjs — Polling-based watcher for ClickUp tasks (and lists)
 *
 * Snapshots a task's baseline (status, comment count / latest comment id,
 * assignees, date_updated) then polls the ClickUp API on an interval. When a
 * watched change is detected vs the baseline it prints a concise JSON summary
 * of what changed and EXITS 0 — so a parent agent running this with
 * run_in_background=true gets woken by the task-notification. On timeout it
 * also exits 0 with a "timeout" summary.
 *
 * Unlike watch-task/listen.mjs (webhook.site + whcli relay), this watcher is
 * fully self-contained: it needs nothing beyond a working ClickUp API token,
 * so it runs anywhere the rest of the skill runs.
 *
 * Usage:
 *   node watch.mjs <taskId|taskUrl>
 *   node watch.mjs --list <listId|listUrl>
 *
 * Flags:
 *   --timeout <sec>            Max seconds to watch before giving up (default 3600)
 *   --interval <sec>           Poll cadence in seconds (default 45; min 10)
 *   --on <types>              Comma list of change types that wake the watcher:
 *                              status,comments,assignee  (default: all three)
 *   --until-status <statuses>  Only wake when the task reaches one of these
 *                              statuses (comma list). Implies --on status.
 *   --account <name>           Use a specific named account from accounts.json
 *   --json                     (default output is already JSON)
 *   --state-file <path>        Optional: write latest change/snapshot JSON here
 *
 * Exit codes:
 *   0  — a watched change fired, OR the watch timed out (both print JSON)
 *   1  — fatal setup/config error (bad task id, no auth, etc.)
 */

import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { initClient } from './api/client.mjs';
import { getTask, getTasksInList } from './api/tasks.mjs';
import { getComments } from './api/comments.mjs';
import { parseTaskId, parseListId } from './lib/parse.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return argv[i + 1];
}
function has(name) {
  return argv.includes(`--${name}`);
}

function fatal(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

// First positional (not a flag, not a flag value) is the task id/url.
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    // Boolean flags take no value; value flags consume the next token.
    if (!['json'].includes(a.slice(2))) i++;
    continue;
  }
  positional.push(a);
}

const listInput = flag('list');
const taskInput = positional[0];

if (!listInput && !taskInput) {
  fatal(
    'Provide a task id/url, or --list <listId>.\n' +
      'Usage: node watch.mjs <taskId> [--timeout 3600] [--interval 45] ' +
      '[--on status,comments,assignee] [--until-status "in progress,complete"]'
  );
}

const timeoutSec = Math.max(parseInt(flag('timeout') || '3600', 10), 5);
const intervalSec = Math.max(parseInt(flag('interval') || '45', 10), 10);
const account = flag('account');
const stateFile = flag('state-file');

const untilStatusRaw = flag('until-status');
const untilStatuses = untilStatusRaw
  ? untilStatusRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  : null;

let onTypes;
const onRaw = flag('on');
if (onRaw) {
  onTypes = new Set(onRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
} else {
  onTypes = new Set(['status', 'comments', 'assignee']);
}
// --until-status is a status-based wake condition; make sure status is watched.
if (untilStatuses) onTypes.add('status');

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

try {
  initClient(account);
} catch (err) {
  fatal(err.message);
}

const mode = listInput ? 'list' : 'task';
let targetId;
if (mode === 'list') {
  targetId = parseListId(listInput) || listInput;
} else {
  targetId = parseTaskId(taskInput);
}
if (!targetId) fatal(`Could not parse ${mode} id from input.`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeState(obj) {
  if (!stateFile) return;
  try {
    const p = resolve(stateFile);
    writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Snapshotting
// ---------------------------------------------------------------------------

// Reduce a raw task to the fields we compare across polls.
function snapshotTask(task, comments) {
  const assignees = (task.assignees || [])
    .map((a) => a.id)
    .sort((x, y) => String(x).localeCompare(String(y)));
  const latest = comments && comments.length ? comments[comments.length - 1] : null;
  return {
    id: task.id,
    name: task.name,
    status: task.status?.status ?? null,
    statusType: task.status?.type ?? null,
    dateUpdated: task.date_updated ?? null,
    assignees,
    assigneeNames: (task.assignees || []).map((a) => a.username || a.email || String(a.id)),
    commentCount: comments ? comments.length : null,
    latestCommentId: latest ? latest.id : null,
  };
}

async function snapshotTaskById(id) {
  const task = await getTask(id);
  let comments = null;
  if (onTypes.has('comments')) {
    try {
      comments = await getComments(id);
    } catch {
      comments = null; // don't let a comment fetch failure abort snapshotting
    }
  }
  return snapshotTask(task, comments);
}

// Compare two task snapshots and return array of change descriptors.
function diffTask(prev, cur) {
  const changes = [];

  if (onTypes.has('status') && prev.status !== cur.status) {
    changes.push({ type: 'status', from: prev.status, to: cur.status });
  }

  if (onTypes.has('assignee')) {
    const a = new Set(prev.assignees.map(String));
    const b = new Set(cur.assignees.map(String));
    const added = [...b].filter((x) => !a.has(x));
    const removed = [...a].filter((x) => !b.has(x));
    if (added.length || removed.length) {
      changes.push({
        type: 'assignee',
        added,
        removed,
        current: cur.assigneeNames,
      });
    }
  }

  if (onTypes.has('comments')) {
    if (
      prev.latestCommentId !== cur.latestCommentId ||
      (prev.commentCount != null && cur.commentCount != null && cur.commentCount > prev.commentCount)
    ) {
      changes.push({
        type: 'comments',
        newCount: cur.commentCount,
        prevCount: prev.commentCount,
        latestCommentId: cur.latestCommentId,
      });
    }
  }

  return changes;
}

// A change only satisfies --until-status when the new status matches.
function passesUntilStatus(changes, cur) {
  if (!untilStatuses) return true;
  const s = (cur.status || '').toLowerCase();
  return untilStatuses.includes(s);
}

// ---------------------------------------------------------------------------
// List-mode snapshot (map of taskId -> per-task snapshot)
// ---------------------------------------------------------------------------

async function snapshotList(id) {
  const tasks = await getTasksInList(id);
  const map = {};
  for (const t of tasks) {
    // In list mode we skip per-task comment fetches to stay gentle on the API;
    // status + assignee + date_updated are compared. New/removed tasks tracked too.
    map[t.id] = snapshotTask(t, null);
  }
  return map;
}

function diffList(prev, cur) {
  const changes = [];
  const prevIds = new Set(Object.keys(prev));
  const curIds = new Set(Object.keys(cur));

  for (const id of curIds) {
    if (!prevIds.has(id)) {
      changes.push({ type: 'taskCreated', taskId: id, name: cur[id].name, status: cur[id].status });
      continue;
    }
    const sub = diffTask(prev[id], cur[id]);
    for (const c of sub) {
      changes.push({ ...c, taskId: id, name: cur[id].name });
    }
    if (onTypes.has('status') && prev[id].dateUpdated !== cur[id].dateUpdated && prev[id].status === cur[id].status) {
      // date_updated moved without a status/assignee change we track; note as generic update
      // (kept lightweight — only surfaced if nothing else fired for this task)
    }
  }
  for (const id of prevIds) {
    if (!curIds.has(id)) {
      changes.push({ type: 'taskDeleted', taskId: id, name: prev[id].name });
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Main watch loop
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutSec * 1000;

  let baseline;
  try {
    baseline = mode === 'list' ? await snapshotList(targetId) : await snapshotTaskById(targetId);
  } catch (err) {
    fatal(`Failed to snapshot ${mode} ${targetId}: ${err.message}`);
  }

  const baseInfo = {
    mode,
    targetId,
    interval: intervalSec,
    timeout: timeoutSec,
    on: [...onTypes],
    untilStatus: untilStatuses,
    baseline: mode === 'task' ? baseline : { taskCount: Object.keys(baseline).length },
    startedAt: new Date(startedAt).toISOString(),
  };
  writeState({ event: 'baseline', ...baseInfo });

  let prev = baseline;
  let consecutiveErrors = 0;

  while (Date.now() < deadline) {
    // Sleep first — the baseline was just taken, so poll after one interval.
    const remaining = deadline - Date.now();
    await sleep(Math.min(intervalSec * 1000, Math.max(remaining, 0)));
    if (Date.now() >= deadline) break;

    let cur;
    try {
      cur = mode === 'list' ? await snapshotList(targetId) : await snapshotTaskById(targetId);
      consecutiveErrors = 0;
    } catch (err) {
      // Graceful backoff on API/network/rate-limit errors; never crash the loop.
      consecutiveErrors++;
      const backoff = Math.min(60, intervalSec * Math.pow(2, consecutiveErrors));
      console.error(`poll error (${consecutiveErrors}): ${err.message} — backing off ${backoff}s`);
      await sleep(backoff * 1000);
      continue;
    }

    const changes = mode === 'list' ? diffList(prev, cur) : diffTask(prev, cur);

    if (changes.length) {
      const curSnap = mode === 'task' ? cur : { taskCount: Object.keys(cur).length };
      if (mode === 'task' && !passesUntilStatus(changes, cur)) {
        // A change happened but the until-status gate isn't satisfied yet;
        // advance the baseline so we don't re-report the same change, keep waiting.
        prev = cur;
        continue;
      }
      const result = {
        event: 'change',
        mode,
        targetId,
        name: mode === 'task' ? cur.name : undefined,
        changes,
        snapshot: curSnap,
        elapsedSec: Math.round((Date.now() - startedAt) / 1000),
        url: mode === 'task' ? `https://app.clickup.com/t/${targetId}` : undefined,
      };
      writeState(result);
      console.log(JSON.stringify(result));
      process.exit(0);
    }

    prev = cur;
  }

  const result = {
    event: 'timeout',
    mode,
    targetId,
    timeout: timeoutSec,
    elapsedSec: Math.round((Date.now() - startedAt) / 1000),
    message: 'No watched change detected within timeout.',
  };
  writeState(result);
  console.log(JSON.stringify(result));
  process.exit(0);
}

main().catch((err) => {
  fatal(`Unexpected error: ${err.message}`);
});
