import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getReports, setReportStatus, updateReportNotes } from '$lib/server/reports.service';
import { getResolvedPostReportIds } from '$lib/server/moderation-board.service';
import { removePlacement } from '$lib/server/user-actions.service';
import { canAccess } from '$lib/server/access';
import {
  DEFAULT_REPORT_REASONS,
  DEFAULT_REPORT_STATUSES,
  reportEntityForSlug,
  reportReasons,
  reportStatuses,
  ReportStatus,
  type ReportReason,
} from '$lib/reports';

const isStatus = (v: string): v is ReportStatus => (reportStatuses as string[]).includes(v);
const isReason = (v: string): v is ReportReason => (reportReasons as string[]).includes(v);

export const load: PageServerLoad = async ({ params, url }) => {
  const type = reportEntityForSlug(params.slug);
  if (!type) error(404, 'Unknown report type');

  // Canonicalize a bare landing so the active default filters are explicit (and shareable) in the URL.
  // Only absent params get defaults — a present-but-empty `?status=` is a deliberate clear, left alone.
  if (!url.searchParams.has('status')) {
    const canonical = new URL(url);
    DEFAULT_REPORT_STATUSES.forEach((s) => canonical.searchParams.append('status', s));
    redirect(307, canonical.pathname + canonical.search);
  }

  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const urlStatuses = url.searchParams.getAll('status').filter(isStatus);
  const urlReasons = url.searchParams.getAll('reason').filter(isReason);
  const reportedBy = url.searchParams.get('reportedBy')?.trim() || '';

  // A present-but-empty param (`?status=`/`?reason=`) is an explicit clear → all; an absent param → the
  // default review view. Both defaults must stay equal to what the badge counts, or a moderator lands on
  // a list that disagrees with the number they clicked.
  const statuses = url.searchParams.has('status') ? urlStatuses : DEFAULT_REPORT_STATUSES;
  const reasons = url.searchParams.has('reason') ? urlReasons : DEFAULT_REPORT_REASONS;

  const data = await getReports({
    type,
    page,
    // An empty selection is every one, said explicitly rather than implied by omission.
    statuses: statuses.length ? statuses : 'all',
    reasons: reasons.length ? reasons : 'all',
    reportedBy: reportedBy || undefined,
  });

  // The default reason set is NOT echoed into the filter control: eight pre-ticked chips read as a
  // heavily-narrowed view when it is the ordinary one. The page says what it is hiding instead, and only
  // while it is hiding it — once reasons are chosen explicitly, the choice is the whole story.
  return {
    type,
    statuses,
    reasons: urlReasons,
    hidingAutomated: !url.searchParams.has('reason'),
    reportedBy,
    ...data,
  };
};

// Access is gated globally in hooks.server.ts (route-tier check), so actions don't re-check here.
export const actions: Actions = {
  setStatus: async ({ request, locals, getClientAddress }) => {
    const data = await request.formData();
    const id = Number(data.get('id'));
    const status = String(data.get('status'));
    if (!id || !isStatus(status)) return fail(400, { message: 'Invalid input' });

    // `setReportStatus` RETURNS its outcome; discarding it reported success for a report another
    // moderator had already actioned or deleted. Same defect the batch sweep had — and this is the
    // path used all day.
    const result = await setReportStatus({
      id,
      status,
      userId: locals.user.id,
      ip: getClientAddress(),
    });
    if (!result.ok) return fail(400, { message: result.error });
    if (!result.changed)
      return fail(409, { message: 'Someone else already set that status. Reload.' });
    return { success: true };
  },
  /**
   * Retool's `ActionAllPostReports`. Post reports whose post is already entirely blocked are resolved
   * by the content — the row is open only because nobody clicked it. Retool swept them in one go; the
   * port had the verb (`setStatus`) and not the SELECT, so the sweep had to be done by hand.
   *
   * Actioned, not Unactioned: the content WAS removed, so the report was correct.
   */
  actionResolvedPosts: async ({ locals, getClientAddress }) => {
    const ids = await getResolvedPostReportIds();
    if (!ids.length)
      return fail(400, { message: 'No post reports are already resolved by content.' });

    // `setReportStatus` RETURNS its outcome rather than throwing: `ok:false` when the report is gone,
    // and `ok:true, changed:false` when someone else already put it in this status. Counting the loop
    // instead of the results reported "actioned N of N" for a run that changed nothing.
    let actioned = 0;
    let skipped = 0;
    for (const id of ids) {
      const result = await setReportStatus({
        id,
        status: ReportStatus.Actioned,
        userId: locals.user.id,
        ip: getClientAddress(),
      });
      if (result.ok && result.changed) actioned += 1;
      else skipped += 1;
    }

    // The SELECT is capped, so a full batch means there are probably more behind it.
    return { success: true, actioned, skipped, found: ids.length, more: ids.length === 500 };
  },

  /**
   * The removal path main added with the `StickerPlacement` reason (#3766). Delegated, not
   * reimplemented: the service settles escrow, and that must have one implementation.
   */
  removePlacement: async ({ request, locals }) => {
    // Acting on reported content, not merely reading the queue — gated on its own path.
    if (!canAccess(locals.user, '/reports')) return fail(403, { message: 'Not permitted.' });

    const data = await request.formData();
    const placementId = Number(data.get('placementId'));
    if (!Number.isInteger(placementId) || placementId <= 0)
      return fail(400, { message: 'Invalid placement.' });

    const result = await removePlacement({ placementId, moderatorId: locals.user.id });
    if (!result.ok) return fail(400, { message: result.error });
    return { success: true, placementRemoved: placementId };
  },

  saveNotes: async ({ request }) => {
    const data = await request.formData();
    const id = Number(data.get('id'));
    if (!id) return fail(400, { message: 'Invalid input' });

    const internalNotes = String(data.get('internalNotes') ?? '').trim() || null;
    await updateReportNotes({ id, internalNotes });
    return { success: true };
  },
};
