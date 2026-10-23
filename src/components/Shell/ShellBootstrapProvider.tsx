import type { QueryClient } from '@tanstack/react-query';
import { hydrate, useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { getCookies } from 'cookies-next';
import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ShellPageData } from '~/components/Shell/shell-page-data';
import {
  adoptShellPageData,
  shellFallbackUrl,
  shellNavigation,
} from '~/components/Shell/shell-page-data';
import type { AppShellUpgrade } from '~/providers/AppProvider';
import type { FeatureFlagsSeed } from '~/providers/FeatureFlagsProvider';
import type { SessionSeed } from '~/providers/SessionProvider';
import type { ParsedCookies } from '~/shared/utils/cookies';
import { parseCookies } from '~/shared/utils/cookies';
import { clientTransformer } from '~/shared/utils/trpc-union-transformer';
import { trpc } from '~/utils/trpc';

export type ShellStatus = 'pending' | 'ready' | 'failed';

const ShellBootstrapContext = createContext<{ status: ShellStatus } | null>(null);

/** Mounted by `_app` only for an app that booted on a shell page. */
export function ShellBootstrapProvider({
  status,
  children,
}: {
  status: ShellStatus;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ status }), [status]);
  return <ShellBootstrapContext.Provider value={value}>{children}</ShellBootstrapContext.Provider>;
}

/** False only while a shell boot is still waiting for (or failed to get) its page data. */
export function useShellReady() {
  const context = useContext(ShellBootstrapContext);
  return !context || context.status === 'ready';
}

/** The `_app` values a shell boot replaces, as the current page passed them. */
type ShellPageInputs = {
  onShellPage: boolean;
  /** Absent on a client-side navigation, where the jar is read instead. */
  cookies?: ParsedCookies;
  hasAuthCookie: boolean;
  adsGated: boolean;
};

type ShellAppProps = {
  cookies: ParsedCookies;
  hasAuthCookie: boolean;
  adsGated: boolean;
  sessionSeed?: SessionSeed | null;
  flagsSeed?: FeatureFlagsSeed | null;
  appShell?: AppShellUpgrade | null;
  referralsPending?: boolean;
  status?: ShellStatus;
};

/**
 * Writes what a server render would have put in the react-query cache, before any state that
 * enables the queries reading it.
 */
function seedShellCaches(queryClient: QueryClient, data: ShellPageData) {
  if (data.trpcState) hydrate(queryClient, clientTransformer.input.deserialize(data.trpcState));
  if (data.settings !== undefined)
    queryClient.setQueryData(getQueryKey(trpc.user.getSettings, undefined, 'query'), data.settings);
  if (data.userFeatureFlags !== undefined)
    queryClient.setQueryData(
      getQueryKey(trpc.user.getFeatureFlags, undefined, 'query'),
      data.userFeatureFlags
    );
  if (data.following !== undefined)
    queryClient.setQueryData(
      getQueryKey(trpc.user.getFollowingUsers, undefined, 'query'),
      data.following
    );
  if (data.chatSettings !== undefined)
    queryClient.setQueryData(
      getQueryKey(trpc.chat.getUserSettings, undefined, 'query'),
      data.chatSettings
    );
  if (data.navBanners !== undefined)
    queryClient.setQueryData(
      getQueryKey(trpc.event.getNavBanners, undefined, 'query'),
      data.navBanners
    );
}

/**
 * The shell boot's half of `_app`. Inactive (`active` false) it hands the page's values back and
 * does nothing else. Active, it reads the cookies and adopts the page data once, after hydration,
 * and until both have arrived it holds every viewer-dependent provider in its fail-closed pending
 * state. A page-data answer other than 200 leaves the shell for a full render.
 */
export function useShellBootstrap(active: boolean, page: ShellPageInputs): ShellAppProps {
  const queryClient = useQueryClient();
  const [cookies, setCookies] = useState<ParsedCookies | null>(null);
  const [data, setData] = useState<ShellPageData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!active) return;
    setCookies(parseCookies(getCookies()));
    let cancelled = false;
    const fallBack = (status: number) => {
      setFailed(true);
      const to = shellFallbackUrl(status, window.location.href);
      if (to) shellNavigation.replace(to);
    };
    void adoptShellPageData().then((result) => {
      if (cancelled) return;
      if (!result.ok) return fallBack(result.status);
      try {
        seedShellCaches(queryClient, result.data);
      } catch {
        return fallBack(500);
      }
      setData(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [active, queryClient]);

  const ready = !!data && !!cookies;
  const sessionSeed = useMemo(
    () => (data && ready ? { session: data.session } : null),
    [data, ready]
  );
  const flagsSeed = useMemo(() => (data && ready ? { flags: data.flags } : null), [data, ready]);
  const appShell = useMemo(
    () =>
      data && ready
        ? { region: data.region, tosMeta: data.tosMeta, siteAlerts: data.siteAlerts }
        : null,
    [data, ready]
  );

  const pageValues = {
    // `_app`'s own default, kept off the shell page: there the hydration render must match the
    // viewer-independent server HTML, so the jar is read only in the effect above.
    cookies: page.cookies ?? parseCookies(page.onShellPage ? {} : getCookies()),
    hasAuthCookie: page.hasAuthCookie,
    adsGated: page.adsGated,
  };
  if (!active) return pageValues;

  return {
    // Only the shell page's own values are the viewer-independent placeholders; a page reached
    // by client navigation afterwards carries real ones.
    ...(page.onShellPage
      ? {
          cookies: cookies ?? pageValues.cookies,
          hasAuthCookie: data && ready ? !!data.session : page.hasAuthCookie,
          adsGated: data && ready ? data.adsGated : true,
        }
      : pageValues),
    sessionSeed,
    flagsSeed,
    appShell,
    referralsPending: !ready,
    status: ready ? 'ready' : failed ? 'failed' : 'pending',
  };
}
