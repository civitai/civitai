import { hostname } from 'node:os';
import { canAccess } from '$lib/server/access';
import { logToAxiom } from '$lib/server/axiom';
import { dbRead, dbWrite } from '$lib/server/db';
import { getModeratorDb } from '$lib/server/moderator-db';
import { scanTexts } from '$lib/server/text-scan-lab/harness-client';
import { requestCookie } from '$lib/server/user-actions.service';
import { WORKSPACES, WORKSPACE_PATHS } from '$lib/text-scan-tests/types';
import { liveRuleStateHash } from './rule-state';
import {
  newWorkerId,
  releaseOwnLeases,
  resumableRunIds,
  runWorker,
  type WorkerDeps,
} from './worker';

const WORKER_ID = newWorkerId();

/** `credential`: the session cookie the worker's harness calls forward. Never log or store it. */
export const workerDeps = (credential: string): WorkerDeps => ({
  db: getModeratorDb(),
  main: dbRead,
  scanTexts: (entityType, texts, overrides) => scanTexts(entityType, texts, overrides, credential),
  workerId: WORKER_ID,
  liveRuleStateHash: () => liveRuleStateHash(dbWrite),
  log: (event, data, level = 'error') =>
    void logToAxiom({ type: level, name: 'text-scan', event, ...data }).catch(() => {}),
});

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
export async function resumeRuns(viewer: Parameters<typeof canAccess>[0]): Promise<void> {
  const workspaces = WORKSPACES.filter((w) => canAccess(viewer, WORKSPACE_PATHS[w]));
  if (!workspaces.length) return;
  for (const runId of await resumableRunIds(getModeratorDb(), workspaces)) start(runId, false);
}

export const releaseLeasesAtBoot = () => releaseOwnLeases(getModeratorDb(), hostname());
