import { ReportStatus } from '@civitai/db-schema/enums';

export { ReportStatus };

// The queue is filtered by a single status. Labels diverge from the raw enum: Actioned = the owner's
// suggested level was granted; Unactioned = a moderator applied a different level (overrode).
export type RatingReviewStatusFilter = 'Pending' | 'Actioned' | 'Unactioned';

export const ratingReviewStatusFilters: { value: RatingReviewStatusFilter; label: string }[] = [
  { value: 'Pending', label: 'Pending' },
  { value: 'Actioned', label: 'Approved' },
  { value: 'Unactioned', label: 'Rejected' },
];

export const ratingReviewStatusBadge: Record<string, { label: string; class: string }> = {
  Pending: { label: 'Pending', class: 'bg-yellow-500/15 text-yellow-300' },
  Actioned: { label: 'Approved', class: 'bg-teal-500/15 text-teal-300' },
  Unactioned: { label: 'Rejected', class: 'bg-red-500/15 text-red-300' },
  Processing: { label: 'Processing', class: 'bg-orange-500/15 text-orange-300' },
};
