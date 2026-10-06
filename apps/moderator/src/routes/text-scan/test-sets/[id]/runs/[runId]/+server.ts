import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { RunError, getRunProgress } from '$lib/server/text-scan-lab/runs.service';

const idOf = (raw: string) => {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

/** A run's progress, polled while it scans. Gated, like the set page, by the test-sets page grant. */
export const GET: RequestHandler = async ({ params }) => {
  const setId = idOf(params.id);
  const runId = idOf(params.runId);
  if (!setId || !runId) return json({ error: 'No such run.' }, { status: 404 });
  try {
    return json(await getRunProgress(setId, runId));
  } catch (e) {
    if (e instanceof RunError) return json({ error: e.message }, { status: e.status });
    throw e;
  }
};
