import { hostname } from 'node:os';
import type { canAccess } from '$lib/server/access';
import { logAxiomError, logToAxiom } from '$lib/server/axiom';
import { dbRead } from '$lib/server/db';
import { getModeratorDb } from '$lib/server/moderator-db';
import { getPrompts, quoteTexts, scanTexts } from '$lib/server/text-scan-lab/harness-client';
import { recordModActivity } from '$lib/server/mod-activity';
import { requestCookie } from '$lib/server/user-actions.service';
import { WORKSPACES } from '$lib/text-scan-tests/types';
import { canOpenWorkspace } from './guard';
import type { RunAuditEvent, RunsDeps } from './runs';
import { TestSetError } from './store';
import {
  newWorkerId,
  releaseOwnLeases,
  resumableRunIds,
  runWorker,
  type WorkerDeps,
} from './worker';

const WORKER_ID = newWorkerId();
type Viewer = Parameters<typeof canAccess>[0];

/** `credential`: the session cookie the worker's harness calls forward. */
export const workerDeps = (credential: string): WorkerDeps => ({
  db: getModeratorDb(),
  main: dbRead,
  scanTexts: (entityType, texts, overrides) => scanTexts(entityType, texts, overrides, credential),
  workerId: WORKER_ID,
  log: (event, data, level = 'error') =>
    void logToAxiom({ type: level, name: 'text-scan', event, ...data }).catch(() => {}),
});

const MOD_ACTIVITY = { start: 'startTestSetRun', cancel: 'cancelTestSetRun' } as const;

/** Ids and counts only: neither sink ever sees case text. */
async function auditRun(event: RunAuditEvent) {
  const { action, userId, setId, runIds, calls, buzz } = event;
  await recordModActivity({
    userId,
    entityType: 'textScanTestSet',
    entityId: setId,
    activity: MOD_ACTIVITY[action],
  });
  await logToAxiom({
    type: 'info',
    name: 'text-scan',
    event: `test-set-run-${action}`,
    setId,
    runIds,
    userId,
    ...(calls === undefined ? {} : { calls }),
    ...(buzz === undefined ? {} : { buzz }),
  }).catch(() => {});
}

/**
 * `credential`: the session cookie from `requestCookie()` at the call site; the harness quote
 * forwards it. Without one nothing can be quoted or started.
 */
export function runsDeps(credential: string | null): RunsDeps {
  if (!credential)
    throw new TestSetError('Your session could not be read. Sign in again and retry.', 401);
  return {
    db: getModeratorDb(),
    getPrompts: () => getPrompts(),
    quoteTexts: (entityType, texts, prompts) => quoteTexts(entityType, texts, prompts, credential),
    launch: (runId) => void launchRun(runId),
    audit: auditRun,
  };
}

/**
 * Must be called while handling a request: the worker forwards that request's session. False when
 * there is none; the run stays queued and resumes on a later view.
 */
export function launchRun(runId: number): boolean {
  return start(runId, true);
}

function start(runId: number, launch: boolean): boolean {
  const credential = requestCookie();
  if (!credential) return false;
  void runWorker(workerDeps(credential), runId, { launch });
  return true;
}

/** Resumes, under the viewer's session, the runs of sets in the workspaces the viewer can open. */
export async function resumeRuns(viewer: Viewer): Promise<void> {
  const workspaces = WORKSPACES.filter((w) => canOpenWorkspace(viewer, w));
  if (!workspaces.length) return;
  for (const runId of await resumableRunIds(getModeratorDb(), workspaces)) start(runId, false);
}

// Needs the request scope: the worker forwards this viewer's session.
export const kickResume = (viewer: Viewer, setId: number) =>
  void resumeRuns(viewer).catch((e) =>
    logAxiomError(e, { event: 'text-scan test run resume failed', setId })
  );

export const releaseLeasesAtBoot = () => releaseOwnLeases(getModeratorDb(), hostname());
