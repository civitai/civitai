import React, { createContext, useContext, useState } from 'react';
import type { UserContentSettings } from '~/server/schema/user.schema';
import type { TosMeta } from '~/server/services/content.service';
import type { RegionInfo } from '~/server/utils/region-blocking';
import type { VerifiedBot } from '~/server/utils/bot-detection/verify-bot';
import type { ColorDomain, ServerDomains } from '~/shared/constants/domain.constants';
import { setServerDomains } from '~/utils/sync-account';
import { trpc } from '~/utils/trpc';
import type { AnnouncementsSeed } from '~/providers/announcements-seed';
import { reviveAnnouncementsSeed } from '~/providers/announcements-seed';

type AppProviderProps = {
  children: React.ReactNode;
  settings: UserContentSettings;
  // Static per-domain ToS metadata (lastmod + body hash + settings field keys).
  // Exposed via context; `useToSUpdateModal` compares it against the seeded
  // `user.getSettings` to decide whether to show the ToS modal.
  tosMeta?: TosMeta;
  // SSR-computed `announcement.getAnnouncements` result (anon + authed). Carried
  // down to `useGetAnnouncements`, which seeds the query under the client's
  // `useDomainColor()` key — this provider sits above FeatureFlagsProvider so it
  // can't compute that key itself.
  announcements?: AnnouncementsSeed;
  // SSR-computed `user.getFollowingUsers` result (logged-in only) — the list of
  // followed userIds. Seeds the query directly (fixed `undefined` key) so the
  // ambient follow/notify buttons never fire it on bootstrap.
  following?: number[];
  seed: number;
  canIndex: boolean;
  region: RegionInfo;
  domain: ColorDomain;
  host: string;
  serverDomains: ServerDomains;
  availableOAuthProviders: string[];
  verifiedBot: VerifiedBot | null;
  // Whether the request is from a logged-in user (`!!session || hasAuthCookie`,
  // computed in _app). AppProvider sits ABOVE SessionProvider so it can't use
  // `useSession()` — this prop is its only auth signal. Used to gate the ambient
  // `user.getSettings` query (a protectedProcedure) so logged-out users don't fire
  // a guaranteed-401 fetch; the SSR `initialData` still seeds the cache for them.
  isAuthed: boolean;
};

type AppContext = {
  seed: number;
  canIndex: boolean;
  region: RegionInfo;
  allowMatureContent: boolean;
  domain: Record<ColorDomain, boolean>;
  host: string;
  serverDomains: ServerDomains;
  availableOAuthProviders: string[];
  verifiedBot: VerifiedBot | null;
  announcements?: AnnouncementsSeed;
  tosMeta?: TosMeta;
};
const Context = createContext<AppContext | null>(null);
export function useAppContext() {
  const context = useContext(Context);
  if (!context) throw new Error('missing AppProvider in tree');
  return context;
}

/**
 * Returns the canonical (primary) host for each color. Use this for outbound
 * URL construction — never link to an alias host.
 */
export function useServerDomains(): Record<ColorDomain, string> {
  const { serverDomains } = useAppContext();
  return {
    green: serverDomains.green?.primary ?? 'civitai.green',
    blue: serverDomains.blue?.primary ?? 'civitai.com',
    red: serverDomains.red?.primary ?? 'civitai.red',
  };
}
export function AppProvider({
  children,
  settings,
  tosMeta,
  announcements,
  following,
  domain,
  host,
  serverDomains,
  availableOAuthProviders,
  verifiedBot,
  isAuthed,
  ...appContext
}: AppProviderProps) {
  // Gate on `isAuthed` — `user.getSettings` is a protectedProcedure, so firing it
  // for a logged-out user is a guaranteed 401. `initialData` still seeds the cache
  // for everyone; only the network fetch is suppressed when not logged in.
  trpc.user.getSettings.useQuery(undefined, { initialData: settings, enabled: isAuthed });
  // Seed `user.getFollowingUsers` (the followed-userId list) from the SSR
  // snapshot so the ambient follow/notify buttons read a primed cache and never
  // fire it on bootstrap. The list only changes via the user's own follow/
  // unfollow, which `FollowUserButton` already patches via optimistic `setData`
  // — so the global `staleTime: Infinity` default is correct here (no external
  // churn to refetch for). `enabled: !!following` skips the seed (and any
  // self-heal fetch) only when there's no snapshot (anon never fires this query;
  // a failed authed snapshot falls back to the consumers' own live fetch).
  trpc.user.getFollowingUsers.useQuery(undefined, {
    initialData: following,
    enabled: !!following,
  });
  // Populate the module-level server domain map so `syncAccount(url)` can
  // resolve hosts to colors without pulling from React context.
  setServerDomains(serverDomains);
  const [state] = useState(() => ({
    ...appContext,
    allowMatureContent: domain !== 'green',
    domain: {
      green: domain === 'green',
      blue: domain === 'blue',
      red: domain === 'red',
    },
    host,
    serverDomains,
    availableOAuthProviders,
    verifiedBot,
    announcements: reviveAnnouncementsSeed(announcements),
    // All-string payload (current hash + baseline + field keys) — survives the
    // pageProps JSON round-trip as-is, no revival needed.
    tosMeta,
  }));

  return <Context.Provider value={state}>{children}</Context.Provider>;
}
