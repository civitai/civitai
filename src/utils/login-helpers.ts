import { QS } from '~/utils/qs';

export const loginRedirectReasons = {
  'download-auth': 'The creator of this asset requires you to be logged in to download it',
  'report-content': 'You need to be logged in to report this content',
  'report-model': 'You need to be logged in to report this model',
  'report-review': 'You need to be logged in to report this review',
  'report-article': 'You need to be logged in to report this article',
  'report-user': 'You need to be logged in to report this user',
  'create-review': 'You need to be logged in to add a review',
  'upload-model': 'You need to be logged in to upload a model',
  'train-model': 'You need to be logged in to train a model',
  'notify-model': 'You need to be logged in to get notifications for a model',
  'create-comment': 'You need to be logged in to add a comment',
  'report-comment': 'You need to be logged in to report this comment',
  'confirm-membership': 'You need to be logged in to confirm your membership',
  'follow-user': 'You need to be logged in to follow a user',
  'follow-collection': 'You need to be logged in to follow a collection',
  'hide-content': 'You need to be logged in to hide content',
  'notify-version': 'You need to be logged in to subscribe for notifications',
  'discord-link': 'Login with Discord to link your account',
  'create-article': 'You need to be logged in to create an article',
  'favorite-article': 'You need to be logged in to like an article',
  'post-images': 'You need to be logged in to create a post',
  'add-to-collection': 'You must be logged in to add this resource to a collection',
  'create-bounty': 'You need to be logged in to create a new bounty',
  'perform-action': 'You need to be logged in to perform this action',
  'purchase-buzz': 'You need to be logged in to purchase Buzz',
  'image-gen':
    'Before you can generate, you need to create an account. Choose your preferred sign-in method below.',
  'blur-toggle': 'Displaying NSFW content requires you to be logged in',
  'create-club': 'You need to be logged in to create a club',
  'join-club': 'You need to be logged in to join a club',
  'civitai-vault': 'You need to be logged in to access your Civitai Vault',
  'favorite-model': 'You need to be logged in to favorite a model',
  rater: 'You need to be logged in to play the rating game',
  'switch-accounts': 'Log into the account you wish to add',
  shop: 'You need to be logged in to preview and purchase cosmetics',
  'knights-new-order': 'You need to be logged in to join Knights of the New Order',
  'submit-challenge': 'You need to be logged in to submit entries to a challenge',
};

export type LoginRedirectReason = keyof typeof loginRedirectReasons;
export type LoginLinkOptions = {
  returnUrl?: string;
  reason?: LoginRedirectReason;
};

export const trackedReasons = ['image-gen', 'train-model', 'blur-toggle'] as const;

export function getLoginLink({ returnUrl, reason }: LoginLinkOptions) {
  return `/login?${QS.stringify({ returnUrl, reason })}`;
  // return `/login?returnUrl=${encodeURIComponent(returnUrl)}`;
}
