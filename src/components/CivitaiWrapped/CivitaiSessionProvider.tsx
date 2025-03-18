import type { Session, SessionUser } from 'next-auth';
import { signIn, useSession } from 'next-auth/react';
import { createContext, useContext, useEffect, useMemo } from 'react';
import { useDomainColor } from '~/hooks/useDomainColor';

import { useDomainSync } from '~/hooks/useDomainSync';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ColorDomain } from '~/server/common/constants';
import { UserMeta } from '~/server/schema/user.schema';
import { browsingModeDefaults } from '~/shared/constants/browsingLevel.constants';
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
  const { canChangeBrowsingLevel } = useFeatureFlags();
  useDomainSync(data?.user as SessionUser, status);
  const domain = useDomainColor();

  const sessionUser = useMemo(() => {
    if (!user)
      return {
        type: 'unauthed',
        settings: publicContentSettings[domain],
      } as UnauthedUser;

    const isMember = user.tier != null;
    const isPaidMember = user.tier != null && user.tier !== 'free';
    const currentUser: AuthedUser = {
      type: 'authed',
      ...user,
      isMember,
      isPaidMember,
      memberInBadState: user.memberInBadState,
      refresh: update,
      settings: {
        showNsfw: user.showNsfw,
        browsingLevel: user.browsingLevel,
        disableHidden: disableHidden ?? true,
        allowAds: user.allowAds ?? !isMember ? true : false,
        autoplayGifs: user.autoplayGifs ?? true,
        blurNsfw: user.blurNsfw,
      },
    };

    if (!canChangeBrowsingLevel)
      currentUser.settings = { ...currentUser.settings, ...browsingModeDefaults[domain] };
    return currentUser;
  }, [data?.expires, disableHidden, canViewNsfw]);

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

export type CivitaiSessionUser = SessionUser & {
  isMember: boolean;
  refresh: () => Promise<Session | null>;
  showNsfw: boolean;
  blurNsfw: boolean;
  disableHidden?: boolean;
  browsingLevel: number;
  meta?: UserMeta;
  isPaidMember: boolean;
};

type SharedUser = { settings: BrowsingSettings };
export type AuthedUser = { type: 'authed' } & SharedUser & CivitaiSessionUser;
export type UnauthedUser = { type: 'unauthed' } & SharedUser;

export type CurrentUser = Omit<
  AuthedUser,
  | 'type'
  | 'allowAds'
  | 'showNsfw'
  | 'blurNsfw'
  | 'browsingLevel'
  | 'disableHidden'
  | 'autoplayGifs'
  | 'settings'
>;

type BrowsingSettings = {
  showNsfw: boolean;
  blurNsfw: boolean;
  browsingLevel: number;
  disableHidden: boolean;
  allowAds: boolean;
  autoplayGifs: boolean;
};

type UserChatSettings = {
  muteSounds: boolean;
  acknowledged: boolean;
};

const CivitaiSessionContext = createContext<AuthedUser | UnauthedUser | null>(null);

export const useCivitaiSessionContext = () => {
  const context = useContext(CivitaiSessionContext);
  if (!context) throw new Error('missing CivitaiSessionContext');
  return context;
};

const publicContentSettings: Record<ColorDomain, BrowsingSettings> = {
  green: {
    ...browsingModeDefaults['green'],
    disableHidden: true,
    allowAds: true,
    autoplayGifs: true,
  },
  blue: {
    ...browsingModeDefaults['blue'],
    disableHidden: true,
    allowAds: true,
    autoplayGifs: true,
  },
  red: {
    ...browsingModeDefaults['red'],
    disableHidden: true,
    allowAds: false,
    autoplayGifs: true,
  },
};
