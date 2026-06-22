import React, { createContext, useContext, useState } from 'react';
import type { UserContentSettings } from '~/server/schema/user.schema';
import type { UserSettingsChat } from '~/server/schema/chat.schema';
import type { TosMeta } from '~/server/services/content.service';
import type { RegionInfo } from '~/server/utils/region-blocking';
import type { VerifiedBot } from '~/server/utils/bot-detection/verify-bot';
import type { ColorDomain, ServerDomains } from '~/shared/constants/domain.constants';
import { setServerDomains } from '~/utils/sync-account';
import { trpc } from '~/utils/trpc';
import type { AnnouncementsSeed } from '~/providers/announcements-seed';
import { reviveAnnouncementsSeed } from '~/providers/announcements-seed';
import type { UserNotificationCounts } from '~/server/services/notification.service';

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
  // SSR-computed `user.checkNotifications` result (logged-in only) — the header
  // bell unread count, reduced to { all, <category>: count }. Seeds the ambient
  // `useQueryNotificationsCount` query (fixed `undefined` key) so it never fires
  // on bootstrap. It's a LIVE count: the existing freshness path (the
  // `NotificationNew` signal + mark-read optimistic `setData`) applies ON TOP of
  // the seed, so it stays current without a refetch — the seed only replaces the
  // one-shot bootstrap fetch.
  notificationCounts?: UserNotificationCounts;
  // SSR-computed `system.getLiveNow` global boolean (a single redis.get,
  // identical for every user). Seeds the ambient `useIsLive` query (fixed
  // `undefined` key) so it never fires on bootstrap. Public procedure → seeded
  // for everyone, no auth gate.
  liveNow: boolean;
  // SSR-computed `chat.getUserSettings` (logged-in only) — the per-user chat
  // settings (mute sounds / bad-word filter / acknowledged). Seeds the ambient
  // query (fixed `undefined` key) so the chat widget never fires it on
  // bootstrap. Static per user (only the user's own `setUserSettings` mutates
  // it, which patches the cache). Absent for anon / fail-open path.
  chatSettings?: UserSettingsChat;
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
  notificationCounts,
  liveNow,
  chatSettings,
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
  // Seed `user.checkNotifications` (the header bell unread count) from the SSR
  // snapshot so `useQueryNotificationsCount` reads a primed cache and never
  // fires the query on bootstrap (~21 req/s off api-primary). Shares the fixed
  // `undefined` query key with that hook. It IS a live count, but freshness
  // does NOT come from a poll — it comes from the `NotificationNew` signal +
  // mark-read optimistic `setData`, both of which apply on top of whatever is in
  // the cache (seed or fetched). The consumer hook sets `staleTime: Infinity`
  // (no time-based refetch today either), so seeding here is behavior-identical:
  // it replaces the single bootstrap fetch and the count self-corrects via the
  // same signal/mutation path as before. Match that `staleTime: Infinity` so the
  // seed counts as fresh and no self-heal fetch fires. `enabled: !!notificationCounts`
  // skips the seed (and any fetch from this provider) when there's no snapshot
  // (anon never fires this protectedProcedure; a failed authed snapshot falls
  // back to the consumer's own live bootstrap fetch).
  trpc.user.checkNotifications.useQuery(undefined, {
    initialData: notificationCounts,
    enabled: !!notificationCounts,
    staleTime: Infinity,
  });
  // Seed the global `system.getLiveNow` boolean from the SSR snapshot so the
  // ambient `useIsLive` consumers (header logo, social links, social home
  // block) read a primed cache and never fire the query on bootstrap. Shares
  // the fixed `undefined` query key with `useIsLive`. `staleTime` matches the
  // hook's 5-minute interval so the seed counts as fresh and no immediate
  // refetch fires; `useIsLive`'s own `refetchInterval`/`refetchOnWindowFocus`
  // still keep it current once a consumer mounts.
  trpc.system.getLiveNow.useQuery(undefined, {
    initialData: liveNow,
    staleTime: 1000 * 60 * 5,
  });
  // Seed `chat.getUserSettings` (per-user chat settings) from the SSR snapshot
  // so the chat widget reads a primed cache and never fires the query on
  // bootstrap (~19 req/s off api-primary). Shares the fixed `undefined` query
  // key with `ChatButton`/`ExistingChat`'s `trpc.chat.getUserSettings.useQuery`.
  // Settings are static per user — only the user's own `setUserSettings`
  // mutation changes them, and it patches the cache via `setData` — so the
  // global `staleTime: Infinity` default is correct (no external churn to poll
  // for). `enabled: !!chatSettings` skips the seed (and any self-heal fetch)
  // only when there's no snapshot: anon never fires this protected query, and a
  // failed/degraded authed snapshot falls back to the widget's own live fetch.
  trpc.chat.getUserSettings.useQuery(undefined, {
    initialData: chatSettings,
    enabled: !!chatSettings,
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
