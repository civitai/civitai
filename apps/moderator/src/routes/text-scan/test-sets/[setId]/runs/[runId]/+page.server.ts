import type { Actions, PageServerLoad } from './$types';
import { requiresGrant } from '$lib/server/access';
import { listModelRules } from '$lib/server/model-rules.service';
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
  const set = await setForView(db, locals.user, setId);
  kickResume(locals.user, setId);
  const report = await runReport(db, setId, runId).catch(viewError);
  const ruleSubjects: Record<number, string> =
    set.workspace === 'modelRules'
      ? Object.fromEntries((await listModelRules()).map((r) => [r.id, r.subject]))
      : {};
  return {
    report,
    ruleSubjects,
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
