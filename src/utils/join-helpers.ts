import { QS } from '~/utils/qs';

export const joinRedirectReasons = {
  'early-access': 'This asset is in Early Access and you need to be a member to download it',
};

export type JoinRedirectReason = keyof typeof joinRedirectReasons;

export function getJoinLink({
  returnUrl,
  reason,
}: {
  returnUrl?: string;
  reason?: JoinRedirectReason;
}) {
  return `/pricing?${QS.stringify({ returnUrl, reason })}`;
}
