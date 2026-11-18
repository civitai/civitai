import type { Actions, PageServerLoad } from './$types';
import { requiresGrant } from '$lib/server/access';
import { getModeratorDb } from '$lib/server/moderator-db';
import { kickResume } from '$lib/server/text-scan-tests/deps';
import {
  archiveSetAction,
  cancelAction,
  editCaseAction,
  importIntentAction,
  removeCaseAction,
} from '$lib/server/text-scan-tests/form-actions';
import { routeId, setForView } from '$lib/server/text-scan-tests/guard';
import { baselineHistory, caseListRow, listRuns } from '$lib/server/text-scan-tests/reports';
import { listCases } from '$lib/server/text-scan-tests/store';
import { isIntentEvalSet } from '$lib/text-scan-tests/intent-set';

export const load: PageServerLoad = async ({ params, locals }) => {
  const setId = routeId(params.setId);
  const db = getModeratorDb();
  const set = await setForView(db, locals.user, setId);
  kickResume(locals.user, setId);
  const [cases, history, runs] = await Promise.all([
    listCases(db, setId),
    baselineHistory(db, setId),
    listRuns(db, setId),
  ]);
  return {
    set,
    cases: cases.map(caseListRow),
    history,
    runs,
    canEdit: !!locals.grants['textScan.testSets.edit'],
    isIntentSet: isIntentEvalSet(setId),
    wide: true,
  };
};

export const actions: Actions = {
  editCase: requiresGrant('textScan.testSets.edit', editCaseAction),
  removeCase: requiresGrant('textScan.testSets.edit', removeCaseAction),
  archiveSet: requiresGrant('textScan.testSets.edit', archiveSetAction),
  importIntent: requiresGrant('textScan.testSets.edit', importIntentAction),
  cancelRun: cancelAction,
};
