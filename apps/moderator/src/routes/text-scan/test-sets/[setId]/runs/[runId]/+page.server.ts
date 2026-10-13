import { error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requiresGrant } from '$lib/server/access';
import { logAxiomError } from '$lib/server/axiom';
import { listModelRules } from '$lib/server/model-rules.service';
import { getModeratorDb } from '$lib/server/moderator-db';
import { resumeRuns } from '$lib/server/text-scan-tests/deps';
import {
  cancelAction,
  editCaseAction,
  rerunAction,
} from '$lib/server/text-scan-tests/form-actions';
import { routeId, setForView } from '$lib/server/text-scan-tests/guard';
import { runReport } from '$lib/server/text-scan-tests/reports';
import { TestSetError } from '$lib/server/text-scan-tests/store';

export const load: PageServerLoad = async ({ params, locals }) => {
  const setId = routeId(params.setId);
  const runId = routeId(params.runId);
  const db = getModeratorDb();
  const set = await setForView(db, locals.user, setId);
  // Inside this request: a resumed worker forwards this viewer's session to the harness.
  void resumeRuns(locals.user).catch((e) =>
    logAxiomError(e, { event: 'text-scan test run resume failed', setId })
  );
  const report = await runReport(db, setId, runId).catch((e: unknown) => {
    if (e instanceof TestSetError) error(e.status, e.message);
    throw e;
  });
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
  editCase: requiresGrant('textScan.testSets.edit', (event) => editCaseAction(event)),
  rerunErrors: (event) => rerunAction(event),
  cancelRun: (event) => cancelAction(event),
};
