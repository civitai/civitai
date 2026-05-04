import type { Session, SessionUser } from 'next-auth';
import { signIn, useSession } from 'next-auth/react';
import { createContext, useContext, useEffect, useMemo } from 'react';
import { useDomainSync } from '~/hooks/useDomainSync';
import { useAppContext } from '~/providers/AppProvider';
import type { UserMeta } from '~/server/schema/user.schema';
import { isRegionRestricted } from '~/server/utils/region-blocking';
import {
  allBrowsingLevelsFlag,
  browsingModeDefaults,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { md5 } from '~/shared/utils/md5';
import { trpc } from '~/utils/trpc';
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
  const { allowMatureContent, region, verifiedBot } = useAppContext();
  const isRestricted = isRegionRestricted(region) && !user?.isModerator;
  useDomainSync(data?.user as SessionUser, status);
  const { data: settings } = trpc.user.getSettings.useQuery();
  const settingsAllowAds = settings?.allowAds;
  const settingsDisableHidden = settings?.disableHidden;
  // User-column toggles now ride the same React Query cache so
  // `BrowserSettingsProvider`'s onSuccess can patch them in-place and avoid
  // the stale-session race (where NextAuth session refresh lags behind the
  // mutation and smart-merge flips the toggle back).
  const settingsShowNsfw = settings?.showNsfw;
  const settingsBlurNsfw = settings?.blurNsfw;
  const settingsAutoplayGifs = settings?.autoplayGifs;

  const sessionUser = useMemo(() => {
    if (!user) {
      // On the SFW site (civitai.com), a verified bot is treated as a
      // regular public user — no special browsing-level expansion. On
      // mature-allowed domains, the bot expresses max preferences so child
      // components surface the gated content the bot is here to index.
      const settings =
        verifiedBot && allowMatureContent
          ? {
              ...publicContentSettings,
              browsingLevel: allBrowsingLevelsFlag,
              showNsfw: true,
              blurNsfw: false,
            }
          : publicContentSettings;
      return { type: 'unauthed', settings } as UnauthedUser;
    }

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
      tier: user.tier ?? 'free',
      settings: {
        // Prefer the getSettings cache (patched instantly on mutation) over
        // session.user (lagging behind until the JWT cookie is refreshed).
        showNsfw: settingsShowNsfw ?? user.showNsfw,
        browsingLevel: isRestricted ? sfwBrowsingLevelsFlag : user.browsingLevel,
        disableHidden: settingsDisableHidden ?? disableHidden ?? true,
        allowAds: settingsAllowAds ?? !isMember ? true : false,
        autoplayGifs: settingsAutoplayGifs ?? user.autoplayGifs ?? true,
        blurNsfw: settingsBlurNsfw ?? user.blurNsfw,
      },
    };
    if (!allowMatureContent)
      currentUser.settings = { ...currentUser.settings, ...browsingModeDefaults };
    return currentUser;
    // data?.expires seems not used but is needed to remotely kill sessions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    data?.expires,
    allowMatureContent,
    disableHidden,
    isRestricted,
    settingsAllowAds,
    settingsDisableHidden,
    settingsShowNsfw,
    settingsBlurNsfw,
    settingsAutoplayGifs,
    verifiedBot,
  ]);

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
  emailHash?: string;
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
