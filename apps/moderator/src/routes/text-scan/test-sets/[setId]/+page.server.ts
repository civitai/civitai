import type { Actions, PageServerLoad } from './$types';
import { requiresGrant } from '$lib/server/access';
import { logAxiomError } from '$lib/server/axiom';
import { getModeratorDb } from '$lib/server/moderator-db';
import { resumeRuns } from '$lib/server/text-scan-tests/deps';
import {
  archiveSetAction,
  cancelAction,
  editCaseAction,
  removeCaseAction,
} from '$lib/server/text-scan-tests/form-actions';
import { routeId, setForView } from '$lib/server/text-scan-tests/guard';
import { baselineHistory, caseListRow, listRuns } from '$lib/server/text-scan-tests/reports';
import { listCases } from '$lib/server/text-scan-tests/store';

export const load: PageServerLoad = async ({ params, locals }) => {
  const setId = routeId(params.setId);
  const db = getModeratorDb();
  const set = await setForView(db, locals.user, setId);
  // Inside this request: a resumed worker forwards this viewer's session to the harness.
  void resumeRuns(locals.user).catch((e) =>
    logAxiomError(e, { event: 'text-scan test run resume failed', setId })
  );
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
    wide: true,
  };
};

export const actions: Actions = {
  editCase: requiresGrant('textScan.testSets.edit', (event) => editCaseAction(event)),
  removeCase: requiresGrant('textScan.testSets.edit', (event) => removeCaseAction(event)),
  archiveSet: requiresGrant('textScan.testSets.edit', (event) => archiveSetAction(event)),
  cancelRun: (event) => cancelAction(event),
};
