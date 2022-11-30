import { QS } from '~/utils/qs';

export const loginRedirectReasons = {
  'download-auth': 'You need to be logged in to download this model',
  'report-model': 'You need to be logged in to report this model',
  'report-review': 'You need to be logged in to report this review',
  'create-review': 'You need to be logged in to create a review',
  'upload-model': 'You need to be logged in to upload a model',
  'favorite-model': 'You need to be logged in to like a model',
};

export type LoginRedirectReason = keyof typeof loginRedirectReasons;

export function getLoginLink({
  returnUrl,
  reason,
}: {
  returnUrl?: string;
  reason?: LoginRedirectReason;
}) {
  return `/login?${QS.stringify({ returnUrl, reason })}`;
  // return `/login?returnUrl=${encodeURIComponent(returnUrl)}`;
}
