import { useSession } from '~/providers/SessionProvider';
import { useMemo } from 'react';
import { useDomainSync } from '~/hooks/useDomainSync';
import { useAppContext } from '~/providers/AppProvider';
import { isRegionRestricted } from '~/server/utils/region-blocking';
import {
  allBrowsingLevelsFlag,
  browsingModeDefaults,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { md5 } from '~/shared/utils/md5';
import { trpc } from '~/utils/trpc';
import {
  DEFAULT_EVENT_POINT_POPS,
  type EventPointPops,
} from '~/shared/constants/event-point-pops.constants';
import {
  CivitaiSessionContext,
  type AuthedUser,
  type BrowsingSettings,
  type UnauthedUser,
} from '~/components/CivitaiWrapped/CivitaiSessionContext';

// The context and its hooks live in ./CivitaiSessionContext; re-exported so this path keeps working.
export {
  useCivitaiSessionContext,
  useOptionalCivitaiSessionContext,
} from '~/components/CivitaiWrapped/CivitaiSessionContext';
export type {
  AuthedUser,
  CivitaiSessionUser,
  CurrentUser,
  UnauthedUser,
} from '~/components/CivitaiWrapped/CivitaiSessionContext';
// const UserBanned = dynamic(() => import('~/components/User/UserBanned'));
// const OnboardingModal = dynamic(() => import('~/components/Onboarding/OnboardingWizard'), {
//   ssr: false,
// });

export function CivitaiSessionProvider({
  children,
  disableHidden,
  showEventCosmetics,
  eventPointPops,
}: {
  children: React.ReactNode;
  disableHidden?: boolean;
  /** This device's choice, from its cookie: what a signed-out viewer gets, and a fallback. */
  showEventCosmetics?: boolean;
  /** This device's choice, from its cookie, until the account's settings are read. */
  eventPointPops?: EventPointPops;
}) {
  const { data, update } = useSession();
  const user = data?.user;
  const { allowMatureContent, region, verifiedBot } = useAppContext();
  // `AppContext.region` is optional because _app's `region` PROP is SSR-only. This CONTEXT
  // read is not: AppProvider freezes its value in a `useState` initializer at mount, so it
  // holds the SSR region for the tab's lifetime. The guard is the type requirement, and a
  // runtime no-op today — `getRegionEffectiveDate` null-guards its argument (`region || {}`),
  // so `isRegionRestricted(undefined)` already answered `false`. 🔴 Note it FAILS OPEN on an
  // absent region (exactly as before, so this changes nothing), which is safe only because
  // that freeze holds and because restriction is independently enforced server-side by
  // `regionRestrictionMiddleware`. Removing the freeze would silently un-clamp this.
  const isRestricted = !!region && isRegionRestricted(region) && !user?.isModerator;
  useDomainSync();
  const { data: settings } = trpc.user.getSettings.useQuery(undefined, {
    enabled: !!user,
  });
  const settingsAllowAds = settings?.allowAds;
  const settingsDisableHidden = settings?.disableHidden;
  // User-column toggles now ride the same React Query cache so
  // `BrowserSettingsProvider`'s onSuccess can patch them in-place and avoid
  // the stale-session race (where NextAuth session refresh lags behind the
  // mutation and smart-merge flips the toggle back).
  const settingsShowNsfw = settings?.showNsfw;
  const settingsBlurNsfw = settings?.blurNsfw;
  const settingsAutoplayGifs = settings?.autoplayGifs;
  const settingsShowEventCosmetics = settings?.showEventCosmetics;
  const settingsEventPointPops = settings?.eventPointPops;

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
      return {
        type: 'unauthed',
        settings: {
          ...settings,
          showEventCosmetics: showEventCosmetics ?? true,
          eventPointPops: eventPointPops ?? DEFAULT_EVENT_POINT_POPS,
        },
      } as UnauthedUser;
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
        // The account's own choice once its settings are read. Before that (a degraded bootstrap)
        // this device's cookie, so an "off" viewer gets no flash of hats.
        showEventCosmetics: settings
          ? settingsShowEventCosmetics ?? true
          : showEventCosmetics ?? true,
        eventPointPops:
          (settings ? settingsEventPointPops : eventPointPops) ?? DEFAULT_EVENT_POINT_POPS,
      },
    };
    if (!allowMatureContent)
      currentUser.settings = { ...currentUser.settings, ...browsingModeDefaults };
    return currentUser;
    // data?.expires seems not used but is needed to remotely kill sessions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    user,
    data?.expires,
    allowMatureContent,
    disableHidden,
    showEventCosmetics,
    eventPointPops,
    isRestricted,
    settingsAllowAds,
    settingsDisableHidden,
    settingsShowNsfw,
    settingsBlurNsfw,
    settingsAutoplayGifs,
    settingsShowEventCosmetics,
    settingsEventPointPops,
    settings,
    verifiedBot,
  ]);

  if (typeof window !== 'undefined') {
    window.isAuthed = sessionUser.type === 'authed';
  }

  return (
    <CivitaiSessionContext.Provider value={sessionUser}>{children}</CivitaiSessionContext.Provider>
  );
}

const publicContentSettings: BrowsingSettings = {
  ...browsingModeDefaults,
  disableHidden: true,
  allowAds: true,
  autoplayGifs: true,
  showEventCosmetics: true,
  eventPointPops: DEFAULT_EVENT_POINT_POPS,
};

const signedOutUser: UnauthedUser = { type: 'unauthed', settings: publicContentSettings };

/** A fixed signed-in session for harnesses with no auth hub (Ladle stories of author-only UI). */
export function FixedSessionProvider({
  user,
  children,
}: {
  /** Only the fields the story's components read; the rest are absent. */
  user: Partial<AuthedUser> & { id: number };
  children: React.ReactNode;
}) {
  const value = { settings: publicContentSettings, ...user, type: 'authed' } as AuthedUser;
  return <CivitaiSessionContext.Provider value={value}>{children}</CivitaiSessionContext.Provider>;
}

/** A fixed signed-out session for harnesses with no auth hub (Ladle). The app mounts
 * `CivitaiSessionProvider`. */
export function SignedOutSessionProvider({ children }: { children: React.ReactNode }) {
  return (
    <CivitaiSessionContext.Provider value={signedOutUser}>
      {children}
    </CivitaiSessionContext.Provider>
  );
}
