import type { TrainingDetail, TrainingRow } from '$lib/data/trainingRows';
import { mainAppWithheldRuns } from './model-status';

/** Who the main app is asked for: the session it reads, and the Studio user it must belong to. */
export interface Asker {
  cookie: string;
  userId: number;
}

export const askerOf = ({ locals, request }: { locals: App.Locals; request: Request }): Asker => ({
  cookie: request.headers.get('cookie') ?? '',
  userId: locals.user.id,
});

// The orchestrator's id charset; anything else (a comma would split the batch) is refused.
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The runs among `workflowIds` whose epoch data is withheld. With no answer from the main app,
 *  every one of them is: the rest of the page still renders. */
export async function withheldRuns(asker: Asker, workflowIds: string[]): Promise<Set<string>> {
  if (workflowIds.length === 0) return new Set();
  if (!workflowIds.every((id) => RUN_ID.test(id))) return new Set(workflowIds);
  try {
    return await mainAppWithheldRuns(asker, workflowIds);
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

export async function gateRows(asker: Asker, rows: TrainingRow[]): Promise<TrainingRow[]> {
  const ids = rows.flatMap((r) => (r.workflowId ? [r.workflowId] : []));
  const withheld = await withheldRuns(asker, ids);
  return rows.map((r) => (r.workflowId && withheld.has(r.workflowId) ? withholdRow(r) : r));
}

/** Thrown when an action would hand out a withheld run's epoch data. */
export class RunWithheldError extends Error {
  constructor() {
    super('This training is not available.');
  }
}

export async function assertNotWithheld(asker: Asker, workflowId: string): Promise<void> {
  if ((await withheldRuns(asker, [workflowId])).has(workflowId)) throw new RunWithheldError();
}
