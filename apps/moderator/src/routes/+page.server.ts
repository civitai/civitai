import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { appRoles } from '@civitai/auth';
import { APP, canAccess } from '$lib/server/access';
import { z } from 'zod';
import { MAX_REPORT_DECISIONS, ReportStatus } from '$lib/reports';
import { parseForm } from '$lib/server/query';
import { setReportStatuses } from '$lib/server/reports.service';
import {
  SWEEP_TASKS,
  acknowledgeSweep,
  type SweepTask,
} from '$lib/server/moderation-board.service';

export const load: PageServerLoad = ({ locals }) => ({
  roles: appRoles(locals.user, APP),
});

/**
 * A page of marks, applied as one gesture. `<id>:<status>` per entry, because a form posts one value
 * per field name and two id lists cannot express "this row was marked twice and the last answer wins".
 */
const decisionsSchema = z.object({
  decisions: z
    .string()
    .transform((raw) =>
      raw
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const [id, status] = part.split(':');
          return { id: Number(id), status };
        })
    )
    .refine((list) => list.length > 0, 'Nothing was marked.')
    .refine((list) => list.length <= MAX_REPORT_DECISIONS, 'Too many at once — save what you have.')
    .refine(
      (list) =>
        list.every(
          (d) =>
            Number.isInteger(d.id) &&
            d.id > 0 &&
            (d.status === ReportStatus.Actioned || d.status === ReportStatus.Unactioned)
        ),
      'Unreadable decision.'
    )
    .transform((list) => list as { id: number; status: ReportStatus }[]),
});

export const actions: Actions = {
  // The most-reported table is fetched client-side, so this action is the dashboard's only server
  // surface for it — and `/` is reachable by every moderator, so it re-checks report access itself.
  saveReports: async ({ request, locals, getClientAddress }) => {
    if (!canAccess(locals.user, '/reports')) return fail(403, { error: 'No access to reports.' });

    const input = parseForm(decisionsSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });

    const result = await setReportStatuses(input.decisions, {
      userId: locals.user.id,
      ip: getClientAddress(),
    });

    // Partial success is the ordinary case here, not an error: another moderator resolving one of
    // these while the page was open is a race. Failing the whole batch would send this moderator back
    // to re-check every report they just ruled on.
    return {
      success: true,
      changed: result.changed,
      unchanged: result.unchanged,
      failed: result.failed,
    };
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
    // Narrowing, not just validating: `acknowledgeSweep` takes the column's enum, so the guard has to
    // convince the compiler as well as the operator.
    if (!SWEEP_TASKS.includes(task as SweepTask)) return fail(400, { error: 'Unknown queue.' });

    await acknowledgeSweep(task as SweepTask, author);
    return { success: true, swept: task };
  },
};
