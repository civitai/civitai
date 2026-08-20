import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { appRoles } from '@civitai/auth';
import { APP, canAccess } from '$lib/server/access';
import { ReportStatus } from '$lib/reports';
import { setReportStatus } from '$lib/server/reports.service';
import { SWEEP_TASKS, acknowledgeSweep } from '$lib/server/moderation-board.service';

export const load: PageServerLoad = ({ locals }) => ({
  roles: appRoles(locals.user, APP),
});

export const actions: Actions = {
  // The most-reported table is fetched client-side, so this action is the dashboard's only server
  // surface — and `/` is reachable by every moderator, so it re-checks report access itself.
  actionReport: async ({ request, locals, getClientAddress }) => {
    if (!canAccess(locals.user, '/reports')) return fail(403, { error: 'No access to reports.' });

    const form = await request.formData();
    const id = Number(form.get('id'));
    if (!id) return fail(400, { error: 'Missing report id.' });

    const status = String(form.get('status'));
    if (status !== ReportStatus.Actioned && status !== ReportStatus.Unactioned)
      return fail(400, { error: 'Unknown status.' });

    // The row dims to "actioned" on success, so a discarded failure left the dashboard asserting an
    // action that did not happen.
    const result = await setReportStatus({
      id,
      status,
      userId: locals.user.id,
      ip: getClientAddress(),
    });
    if (!result.ok) return fail(400, { error: result.error, id });
    if (!result.changed)
      return fail(409, { error: 'Someone else already actioned that report.', id });
    return { success: true, id };
  },

  /**
   * The write half of Retool's task-timer protocol: "I have worked this queue up to now." Without it
   * the mark never advances and every since-last-sweep count grows forever.
   */
  sweep: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/reports')) return fail(403, { error: 'Not permitted.' });
    const author = locals.user.username;
    if (!author) return fail(400, { error: 'Your account has no username to attribute this to.' });

    const form = await request.formData();
    const task = String(form.get('task'));
    if (!(SWEEP_TASKS as readonly string[]).includes(task))
      return fail(400, { error: 'Unknown queue.' });

    await acknowledgeSweep(task, author);
    return { success: true, swept: task };
  },
};
