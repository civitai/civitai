// The `/api/user-reports` payload. Crosses a JSON boundary, so `Date` arrives as `string`.

export type ReportRow = {
  id: number;
  createdAt: string;
  reason: string;
  status: string;
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

export async function fetchUserReports(userId: number): Promise<UserReports> {
  const r = await fetch(`/api/user-reports/${userId}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

/** Retool's `link` column, rebuilt per entity type rather than hardcoded to models and images. */
export function entityUrl(civitaiUrl: string, entityType: string, entityId: number | null) {
  if (!entityId) return null;
  switch (entityType) {
    case 'Image':
      return `${civitaiUrl}/images/${entityId}`;
    case 'Model':
      return `${civitaiUrl}/models/${entityId}`;
    case 'Post':
      return `${civitaiUrl}/posts/${entityId}`;
    case 'Article':
      return `${civitaiUrl}/articles/${entityId}`;
    default:
      // Comments and account reports have no standalone page worth linking to.
      return null;
  }
}
