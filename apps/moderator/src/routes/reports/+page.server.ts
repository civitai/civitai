import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getReports, setReportStatus, updateReportNotes } from '$lib/server/reports.service';
import {
  ReportEntity,
  ReportStatus,
  DEFAULT_REPORT_REASONS,
  reportEntities,
  reportReasons,
  reportStatuses,
  type ReportReason,
} from '$lib/reports';

const DEFAULT_STATUSES: ReportStatus[] = [ReportStatus.Pending, ReportStatus.Processing];

const isEntity = (v: string | null): v is ReportEntity =>
  !!v && (reportEntities as string[]).includes(v);
const isStatus = (v: string): v is ReportStatus => (reportStatuses as string[]).includes(v);
const isReason = (v: string): v is ReportReason => (reportReasons as string[]).includes(v);

export const load: PageServerLoad = async ({ locals, url }) => {
  // Canonicalize a bare landing so the active default filters are explicit (and shareable) in the URL.
  // Only absent params get defaults — a present-but-empty `?status=` is a deliberate clear, left alone.
  if (!url.searchParams.has('type') || !url.searchParams.has('status') || !url.searchParams.has('reason')) {
    const canonical = new URL(url);
    if (!canonical.searchParams.has('type')) canonical.searchParams.set('type', ReportEntity.Model);
    if (!canonical.searchParams.has('status'))
      DEFAULT_STATUSES.forEach((s) => canonical.searchParams.append('status', s));
    if (!canonical.searchParams.has('reason'))
      DEFAULT_REPORT_REASONS.forEach((r) => canonical.searchParams.append('reason', r));
    redirect(307, canonical.pathname + canonical.search);
  }

  const type = isEntity(url.searchParams.get('type'))
    ? (url.searchParams.get('type') as ReportEntity)
    : ReportEntity.Model;
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const urlStatuses = url.searchParams.getAll('status').filter(isStatus);
  const urlReasons = url.searchParams.getAll('reason').filter(isReason);
  const reportedBy = url.searchParams.get('reportedBy')?.trim() || '';

  // A present-but-empty param (`?status=`) is an explicit clear → all; an absent param → the default
  // review view (open statuses, hand-triaged reasons).
  const statuses = url.searchParams.has('status') ? urlStatuses : DEFAULT_STATUSES;
  const reasons = url.searchParams.has('reason') ? urlReasons : DEFAULT_REPORT_REASONS;

  const data = await getReports({ type, page, statuses, reasons, reportedBy: reportedBy || undefined });

  return { type, statuses, reasons, reportedBy, ...data };
};

// Access is gated globally in hooks.server.ts (route-tier check), so actions don't re-check here.
export const actions: Actions = {
  setStatus: async ({ request, locals, getClientAddress }) => {
    const data = await request.formData();
    const id = Number(data.get('id'));
    const status = String(data.get('status'));
    if (!id || !isStatus(status)) return fail(400, { message: 'Invalid input' });

    await setReportStatus({ id, status, userId: locals.user.id, ip: getClientAddress() });
    return { success: true };
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
