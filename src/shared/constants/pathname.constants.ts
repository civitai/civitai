export function getMatchingPathname(url: string) {
  const urlTokens = url.replace(/^\//, '').split('/');
  let match: string | undefined;

  for (const [pathname, tokens] of Object.entries(pathnamesTokens)) {
    const exactMatch = urlTokens.every((token, index) => token === tokens[index]);
    if (exactMatch) {
      match = pathname;
      break;
    }

    const softTokenLength = tokens.filter((part) => !part.includes('[[')).length;
    const softMatch = urlTokens.every(
      (token, index) =>
        (tokens.length === urlTokens.length || softTokenLength === urlTokens.length) &&
        (token === tokens[index] || tokens[index]?.startsWith('['))
    );
    if (softMatch) {
      match = pathname;
    }
  }

  return match ?? url;
}

const pathnamesTokens = [
  '/moderator/test',
  '/404',
  '/air/confirm',
  '/collections/[collectionId]/review',
  '/creator-program',
  '/content/dmca-notice',
  '/content/dmca-counter-notice',
  '/dmca/notice',
  '/games/chopped',
  '/home',
  '/images',
  '/models/[id]/edit',
  '/models/[id]/model-versions/[versionId]/edit',
  '/models',
  '/payment/success',
  '/posts',
  '/product/odor',
  '/product/vault',
  '/search/articles',
  '/search/bounties',
  '/search/collections',
  '/search/models',
  '/search/users',
  '/subscribe/[plan]',
  '/support',
  '/testing/demo',
  '/testing/metadata-test',
  '/user/[username]/[list]',
  '/user/[username]/images',
  '/user/[username]/models',
  '/user/[username]/posts',
  '/user/[username]/videos',
  '/user/downloads',
  '/user/notifications',
  '/videos',
  '/articles/[id]/edit',
  '/articles',
  '/bounties/[id]/edit',
  '/articles/create',
  '/articles/[id]/[[...slug]]',
  '/bounties/[id]/entries/[entryId]/edit',
  '/bounties/[id]/entries/create',
  '/bounties/entries/[entryId]',
  '/bounties/create',
  '/bounties',
  '/claim/buzz/[id]',
  '/builds',
  '/claim/cosmetic/[id]',
  '/clubs/[id]/articles',
  '/clubs/[id]/models',
  '/bounties/[id]/entries/[entryId]',
  '/clubs/[id]/posts/[postId]/edit',
  '/clubs/[id]/posts',
  '/bounties/[id]/[[...slug]]',
  '/clubs/create',
  '/clubs/invites/[clubAdminInviteId]',
  '/clubs',
  '/clubs/[id]',
  '/clubs/manage/[id]/admins',
  '/clubs/manage/[id]/members',
  '/clubs/manage/[id]/revenue',
  '/collections/[collectionId]',
  '/collections',
  '/clubs/manage/[id]/resources',
  '/clubs/manage/[id]/tiers',
  '/content/[[...slug]]',
  '/clubs/manage/[id]',
  '/discord/link-role',
  '/comments/v2/[id]',
  '/events',
  '/images/[imageId]',
  '/',
  '/generate',
  '/intent/avatar',
  '/intent/post',
  '/login',
  '/model-versions/[id]',
  '/leaderboard/[id]',
  '/models/[id]/model-versions/create',
  '/models/[id]/model-versions/[versionId]/wizard',
  '/models/[id]/wizard',
  '/models/create',
  '/models/license/[versionId]',
  '/models/train',
  '/events/[slug]',
  '/models/[id]/reviews',
  '/posts/[postId]/[[...postSlug]]',
  '/posts/[postId]/edit',
  '/payment/paddle',
  '/newsroom',
  '/posts/create',
  '/product/link',
  '/pricing',
  '/questions/create',
  '/purchase/buzz',
  '/questions',
  '/models/[id]/[[...slug]]',
  '/reviews/[reviewId]',
  '/questions/[questionId]/[[...questionDetailSlug]]',
  '/search/images',
  '/safety',
  '/tag/[tagname]',
  '/shop',
  '/user/[username]/articles',
  '/user/[username]/collections',
  '/user/[username]',
  '/user/account',
  '/games/knights-of-new-order',
  '/user/earn-potential',
  '/user/[username]/manage-categories',
  '/user/stripe-connect/onboard',
  '/user/buzz-dashboard',
  '/user/membership',
  '/user/transactions',
  '/user/vault',
].reduce<Record<string, string[]>>(
  (acc, url) => ({ ...acc, [url]: url.replace(/^\//, '').split('/') }),
  {}
);
