import type { Actions, PageServerLoad } from './$types';
import { requiresGrant } from '$lib/server/access';
import { getModeratorDb } from '$lib/server/moderator-db';
import { kickResume } from '$lib/server/text-scan-tests/deps';
import {
  cancelAction,
  editCaseAction,
  rerunAction,
} from '$lib/server/text-scan-tests/form-actions';
import { routeId, setForView, viewError } from '$lib/server/text-scan-tests/guard';
import { runReport } from '$lib/server/text-scan-tests/reports';

export const load: PageServerLoad = async ({ params, locals }) => {
  const setId = routeId(params.setId);
  const runId = routeId(params.runId);
  const db = getModeratorDb();
  await setForView(db, locals.user, setId);
  kickResume(locals.user, setId);
  const report = await runReport(db, setId, runId).catch(viewError);
  return {
    report,
    canEdit: !!locals.grants['textScan.testSets.edit'],
    userId: locals.user.id,
    wide: true,
  };
};

export const actions: Actions = {
  editCase: requiresGrant('textScan.testSets.edit', editCaseAction),
  rerunErrors: rerunAction,
  cancelRun: cancelAction,
};
