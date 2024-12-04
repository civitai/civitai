import type { Session, SessionUser } from 'next-auth';
import { signIn, useSession } from 'next-auth/react';
import dynamic from 'next/dynamic';
import { createContext, useContext, useEffect, useMemo } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { onboardingSteps } from '~/components/Onboarding/onboarding.utils';
import { useDomainSync } from '~/hooks/useDomainSync';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { UserMeta } from '~/server/schema/user.schema';
import {
  browsingModeDefaults,
  nsfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils';
import { useCookies } from '~/providers/CookiesProvider';
import { deleteCookie } from 'cookies-next';
// const UserBanned = dynamic(() => import('~/components/User/UserBanned'));
// const OnboardingModal = dynamic(() => import('~/components/Onboarding/OnboardingWizard'), {
//   ssr: false,
// });

export function CivitaiSessionProvider({ children }: { children: React.ReactNode }) {
  const { data, update, status } = useSession();
  const user = data?.user;
  const { canViewNsfw } = useFeatureFlags();
  const cookies = useCookies();
  useDomainSync(data?.user as SessionUser, status);

  const { disableHidden } = cookies;

  const sessionUser = useMemo(() => {
    if (!user)
      return {
        type: 'unauthed',
        settings: publicContentSettings,
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
        blurNsfw: !Flags.intersection(user.browsingLevel, nsfwBrowsingLevelsFlag)
          ? true
          : user.blurNsfw,
      },
    };
    if (!canViewNsfw) currentUser.settings = { ...currentUser.settings, ...browsingModeDefaults };
    return currentUser;
  }, [data?.expires, disableHidden, canViewNsfw]);

  useEffect(() => {
    if (data?.error === 'RefreshAccessTokenError') signIn();
  }, [data?.error]);

  if (typeof window !== 'undefined') {
    window.isAuthed = sessionUser.type === 'authed';
  }

  useEffect(() => {
    deleteCookie('level');
    deleteCookie('blur');
    deleteCookie('nsfw');
  }, []);

  // useEffect(() => {
  //   const onboarding = data?.user?.onboarding;
  //   if (onboarding !== undefined) {
  //     const shouldOnboard = !onboardingSteps.every((step) => Flags.hasFlag(onboarding, step));
  //     if (shouldOnboard) {
  //       dialogStore.trigger({
  //         component: OnboardingModal,
  //         id: 'onboarding',
  //         props: { onComplete: () => dialogStore.closeById('onboarding') },
  //       });
  //     }
  //   }
  // }, [data?.user?.onboarding]);

  // const isBanned = sessionUser.type === 'authed' ? !!sessionUser.bannedAt : false;

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

const publicContentSettings: BrowsingSettings = {
  ...browsingModeDefaults,
  disableHidden: true,
  allowAds: true,
  autoplayGifs: true,
};
