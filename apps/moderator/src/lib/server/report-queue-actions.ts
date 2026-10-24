import { fail } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { setReportStatus, updateReportNotes } from './reports.service';
import { z } from 'zod';
import { parseForm } from './query';
import { MAX_INT4 } from './users.service';
import { isReportRuling, reportStatuses, type ReportStatus } from '$lib/reports';

const isStatus = (v: string): v is ReportStatus => (reportStatuses as string[]).includes(v);

/**
 * The report's own two writes — its status and its internal notes — shared by every report queue that
 * offers them: the `/reports/[slug]` tables and the model queue. Access is gated globally in
 * hooks.server.ts (route-tier check), so these don't re-check here.
 *
 * `rulingsOnly`: the queue sets an outcome (`REPORT_RULINGS`) and nothing else, as the user queue's
 * `actionReport` does. No caller passes it yet: the model queue sets all four statuses until whether
 * Processing still marks an ownership claim is settled. Refused here and not only by disabled buttons, so a
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

  saveNotes: saveNotesAction(),
});

/** What `ReportNotes` allows, held here too so a hand-built POST cannot store more. */
export const MAX_REPORT_NOTES = 5000;

const notesSchema = z.object({
  id: z.coerce.number().int().positive().max(MAX_INT4),
  internalNotes: z
    .string()
    .trim()
    .max(MAX_REPORT_NOTES, `Notes are capped at ${MAX_REPORT_NOTES.toLocaleString()} characters.`),
});

/**
 * A report's internal notes — ONE action for every queue that renders `ReportNotes`: the tables and
 * the model queue (`reportStatusActions`, behind the route-tier check alone) and the user, post and
 * shared queues (`reportModerationActions`, which pass `permitted` to gate it on their page path, as
 * their ruling is). Two copies had already drifted: one capped the length, the other stored anything.
 */
export function saveNotesAction(permitted: (locals: App.Locals) => boolean = () => true) {
  return async ({ request, locals }: RequestEvent) => {
    if (!permitted(locals)) return fail(403, { scope: 'notes', error: 'Not permitted.' });
    const input = parseForm(notesSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { scope: 'notes', error: input });

    // Empty clears the note. Discarding the outcome reported success for notes that were never
    // stored, because the report was deleted while they were being typed — `gone` reloads the list.
    const result = await updateReportNotes({
      id: input.id,
      internalNotes: input.internalNotes || null,
    });
    if (!result.ok)
      return fail(410, {
        scope: 'notes',
        error: 'That report was deleted while you were editing.',
        gone: true,
      });
    return { success: true };
  };
}
