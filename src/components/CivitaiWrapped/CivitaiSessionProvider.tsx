import type { SessionUser } from 'next-auth';
import { signIn, useSession } from 'next-auth/react';
import { useEffect, useMemo } from 'react';
import { useDomainSync } from '~/hooks/useDomainSync';
import { useAppContext } from '~/providers/AppContext';
import {
  browsingModeDefaults,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { md5 } from '~/shared/utils/md5';
import { trpc } from '~/utils/trpc';
import { isRegionRestricted } from '~/server/utils/region-blocking';
import { CivitaiSessionContext, type AuthedUser, type UnauthedUser } from './CivitaiSessionContext';
// const UserBanned = dynamic(() => import('~/components/User/UserBanned'));
// const OnboardingModal = dynamic(() => import('~/components/Onboarding/OnboardingWizard'), {
//   ssr: false,
// });

export function CivitaiSessionProvider({
  children,
  disableHidden,
}: {
  children: React.ReactNode;
  disableHidden?: boolean;
}) {
  const { data, update, status } = useSession();
  const user = data?.user;
  const { allowMatureContent } = useAppContext();
  const { region } = useAppContext();
  const isRestricted = isRegionRestricted(region) && !user?.isModerator;
  useDomainSync(data?.user as SessionUser, status);
  const { data: settings } = trpc.user.getSettings.useQuery();

  const sessionUser = useMemo(() => {
    if (!user)
      return {
        type: 'unauthed',
        settings: publicContentSettings,
      } as UnauthedUser;

    const isMember = user.tier != null;
    const isPaidMember = !!user.tier && user.tier !== 'free';
    const currentUser: AuthedUser = {
      type: 'authed',
      ...user,
      emailHash: user.email ? md5(user.email) : undefined,
      isMember,
      isPaidMember,
      memberInBadState: user.memberInBadState,
      refresh: update,
      settings: {
        showNsfw: user.showNsfw,
        browsingLevel: isRestricted ? sfwBrowsingLevelsFlag : user.browsingLevel,
        disableHidden: disableHidden ?? true,
        allowAds: settings?.allowAds ?? !isMember ? true : false,
        autoplayGifs: user.autoplayGifs ?? true,
        blurNsfw: user.blurNsfw,
      },
    };
    if (!allowMatureContent)
      currentUser.settings = { ...currentUser.settings, ...browsingModeDefaults };
    return currentUser;
    // data?.expires seems not used but is needed to remotely kill sessions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.expires, disableHidden, allowMatureContent]);

  useEffect(() => {
    if (data?.error === 'RefreshAccessTokenError') signIn();
  }, [data?.error]);

  if (typeof window !== 'undefined') {
    window.isAuthed = sessionUser.type === 'authed';
  }

  return (
    <CivitaiSessionContext.Provider value={sessionUser}>{children}</CivitaiSessionContext.Provider>
  );
}

type BrowsingSettings = {
  showNsfw: boolean;
  blurNsfw: boolean;
  browsingLevel: number;
  disableHidden: boolean;
  allowAds: boolean;
  autoplayGifs: boolean;
};

const publicContentSettings: BrowsingSettings = {
  ...browsingModeDefaults,
  disableHidden: true,
  allowAds: true,
  autoplayGifs: true,
};

// Re-export types and hooks from context file for backward compatibility
export type {
  CivitaiSessionUser,
  AuthedUser,
  UnauthedUser,
  CurrentUser,
} from './CivitaiSessionContext';
export { useCivitaiSessionContext } from './CivitaiSessionContext';
