import type {
  AppAccessRequestStatus,
  AppAccessReviewSource,
} from '~/shared/constants/app-access-request.constants';

/**
 * Who decided a row, as the moderator queue shows it. `system` decides two things: an approval on
 * submit (`app-access-auto-approve`) and a decline when the system account bans someone. So the
 * label keys on the status as well as the source: a system decline must never read as an approval.
 */
export function reviewedByLabel(item: {
  status: AppAccessRequestStatus;
  reviewSource: AppAccessReviewSource | null;
  reviewedByUsername: string | null;
}): string {
  if (item.reviewSource === 'system')
    return item.status === 'approved' ? 'Approved automatically' : 'Declined automatically';
  return item.reviewedByUsername ?? 'a moderator';
}
