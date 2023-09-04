import { QS } from '~/utils/qs';

export const loginRedirectReasons = {
  'download-auth': 'You need to be logged in to download this model',
  'report-content': 'You need to be logged in to report this content',
  'report-model': 'You need to be logged in to report this model',
  'report-review': 'You need to be logged in to report this review',
  'report-article': 'You need to be logged in to report this article',
  'report-user': 'You need to be logged in to report this user',
  'create-review': 'You need to be logged in to add a review',
  'upload-model': 'You need to be logged in to upload a model',
  'train-model': 'You need to be logged in to train a model',
  'favorite-model': 'You need to be logged in to like a model',
  'create-comment': 'You need to be logged in to add a comment',
  'report-comment': 'You need to be logged in to report this comment',
  'follow-user': 'You need to be logged in to follow a user',
  'follow-collection': 'You need to be logged in to follow a collection',
  'hide-content': 'You need to be logged in to hide content',
  'notify-version': 'You need to be logged in to subscribe for notifications',
  'discord-link': 'Login with Discord to link your account',
  'create-article': 'You need to be logged in to create an article',
  'favorite-article': 'You need to be logged in to like an article',
  'post-images': 'You need to be logged in to post images',
  'add-to-collection': 'You must be logged in to add this resource to a collection',
  'create-bounty': 'You need to be logged in to create a new bounty',
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
