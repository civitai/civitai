import { fail } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { setReportStatus, updateReportNotes } from './reports.service';
import { isReportRuling, reportStatuses, type ReportStatus } from '$lib/reports';

const isStatus = (v: string): v is ReportStatus => (reportStatuses as string[]).includes(v);

/**
 * The report's own two writes — its status and its internal notes — shared by every report queue that
 * offers them: the `/reports/[slug]` tables and the model queue. Access is gated globally in
 * hooks.server.ts (route-tier check), so these don't re-check here.
 *
 * `rulingsOnly`: the queue sets an outcome (`REPORT_RULINGS`) and nothing else — the model queue, as
 * the user queue's `actionReport` already did. Refused here and not only by disabled buttons, so a
 * stale tab or a hand-built POST cannot put a report back in Pending or Processing.
 */
export const reportStatusActions = ({ rulingsOnly = false } = {}) => ({
  setStatus: async ({ request, locals, getClientAddress }: RequestEvent) => {
    const data = await request.formData();
    const id = Number(data.get('id'));
    const status = String(data.get('status'));
    if (!id || !isStatus(status)) return fail(400, { error: 'Invalid input' });
    if (rulingsOnly && !isReportRuling(status))
      return fail(400, { error: 'This queue sets Actioned or Unactioned only.' });

    // `setReportStatus` RETURNS its outcome; discarding it reported success for a report another
    // moderator had already actioned or deleted. Same defect the batch sweep had — and this is the
    // path used all day.
    const result = await setReportStatus({
      id,
      status,
      userId: locals.user.id,
      ip: getClientAddress(),
    });
    // `gone` rather than a bare message: the page reloads the queue on it, so the row the moderator
    // is looking at leaves the screen instead of sitting there accepting further clicks.
    if (!result.ok) return fail(410, { error: result.error, gone: true });
    if (!result.changed)
      return fail(409, { error: 'Someone else already set that status. Reload.' });
    return { success: true };
  },

  saveNotes: async ({ request }: RequestEvent) => {
    const data = await request.formData();
    const id = Number(data.get('id'));
    if (!id) return fail(400, { error: 'Invalid input' });

    const internalNotes = String(data.get('internalNotes') ?? '').trim() || null;
    // Discarding the outcome reports success for notes that were never stored, because the report
    // was deleted while they were being typed.
    const result = await updateReportNotes({ id, internalNotes });
    if (!result.ok)
      return fail(410, { error: 'That report was deleted while you were editing.', gone: true });
    return { success: true };
  },
});
