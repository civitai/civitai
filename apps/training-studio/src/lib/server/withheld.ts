import type { TrainingDetail, TrainingRow } from '$lib/data/trainingRows';
import { mainAppWithheldRuns } from './model-status';

/** The runs among `workflowIds` whose epoch data is withheld. With no answer from the main app,
 *  every one of them is: the rest of the page still renders. */
export async function withheldRuns(cookie: string, workflowIds: string[]): Promise<Set<string>> {
  if (workflowIds.length === 0) return new Set();
  try {
    return await mainAppWithheldRuns(cookie, workflowIds);
  } catch (err) {
    console.warn('[training-studio] withheld-runs check failed', err);
    return new Set(workflowIds);
  }
}

export const withholdDetail = (detail: TrainingDetail): TrainingDetail => ({
  ...detail,
  epochs: detail.epochs.map(({ id, number, samples }) => ({
    id,
    number,
    samples: samples.map(() => null),
  })),
});

export const withholdRow = (row: TrainingRow): TrainingRow => ({ ...row, sampleUrls: [] });

export async function gateDetail(cookie: string, detail: TrainingDetail): Promise<TrainingDetail> {
  const withheld = await withheldRuns(cookie, [detail.workflowId]);
  return withheld.has(detail.workflowId) ? withholdDetail(detail) : detail;
}

export async function gateRows(cookie: string, rows: TrainingRow[]): Promise<TrainingRow[]> {
  const ids = rows.flatMap((r) => (r.workflowId ? [r.workflowId] : []));
  const withheld = await withheldRuns(cookie, ids);
  return rows.map((r) => (r.workflowId && withheld.has(r.workflowId) ? withholdRow(r) : r));
}

/** Thrown when an action would hand out a withheld run's epoch data. */
export class RunWithheldError extends Error {
  constructor() {
    super('This training is not available.');
  }
}

export async function assertNotWithheld(cookie: string, workflowId: string): Promise<void> {
  if ((await withheldRuns(cookie, [workflowId])).has(workflowId)) throw new RunWithheldError();
}
