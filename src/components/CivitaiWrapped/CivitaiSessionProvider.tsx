import type { Session, SessionUser } from 'next-auth';
import { signIn, useSession } from 'next-auth/react';
import { createContext, useContext, useEffect, useMemo } from 'react';
import { useDomainSync } from '~/hooks/useDomainSync';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { UserMeta } from '~/server/schema/user.schema';
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
  const { canViewNsfw } = useFeatureFlags();
  useDomainSync(data?.user as SessionUser, status);

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
        blurNsfw: user.blurNsfw,
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

  return (
    <CivitaiSessionContext.Provider value={sessionUser}>{children}</CivitaiSessionContext.Provider>
  );
}

type CivitaiSessionUser = SessionUser & {
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
type AuthedUser = { type: 'authed' } & SharedUser & CivitaiSessionUser;
type UnauthedUser = { type: 'unauthed' } & SharedUser;

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
