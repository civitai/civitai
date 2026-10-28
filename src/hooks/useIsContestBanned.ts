import { useCurrentUser } from '~/hooks/useCurrentUser';

export const useIsContestBanned = () => !!useCurrentUser()?.meta?.contestBanDetails;
