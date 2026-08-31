// The `/api/user-reports` payload. Crosses a JSON boundary, so `Date` arrives as `string`.

import type { ReportEntity } from '$lib/reports';

export type ReportRow = {
  id: number;
  createdAt: string;
  reason: string;
  status: string;
  /** The enum — what resolves a URL or a route. `entityType` beside it is a display label and does
   *  not lowercase to this, which is how it produced dead links when used as a key. */
  type: ReportEntity;
  entityType: string;
  entityId: number | null;
  reporterId: number | null;
  reporter: string | null;
  statusSetBy: string | null;
  statusSetAt: string | null;
  details: unknown;
  internalNotes: string | null;
  alsoReportedBy: number[] | null;
  previouslyReviewedCount: number | null;
};

export type UserReports = {
  received: ReportRow[];
  submitted: ReportRow[];
  onUser: ReportRow[];
};

export async function fetchUserReports(
  userId: number,
  statuses: string[] = []
): Promise<UserReports> {
  const query = statuses.length ? `?status=${statuses.join(',')}` : '';
  const r = await fetch(`/api/user-reports/${userId}${query}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
