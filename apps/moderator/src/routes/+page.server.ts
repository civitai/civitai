import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { appRoles } from '@civitai/auth';
import { APP, canAccess } from '$lib/server/access';
import { ReportStatus } from '$lib/reports';
import { setReportStatus } from '$lib/server/reports.service';

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

    await setReportStatus({ id, status, userId: locals.user.id, ip: getClientAddress() });
    return { success: true, id };
  },
};
