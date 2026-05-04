import React, { createContext, useContext, useState } from 'react';
import type { UserContentSettings } from '~/server/schema/user.schema';
import type { RegionInfo } from '~/server/utils/region-blocking';
import type { VerifiedBot } from '~/server/utils/bot-detection/verify-bot';
import type { ColorDomain, ServerDomains } from '~/shared/constants/domain.constants';
import { setServerDomains } from '~/utils/sync-account';
import { trpc } from '~/utils/trpc';

type AppProviderProps = {
  children: React.ReactNode;
  settings: UserContentSettings;
  seed: number;
  canIndex: boolean;
  region: RegionInfo;
  domain: ColorDomain;
  host: string;
  serverDomains: ServerDomains;
  availableOAuthProviders: string[];
  verifiedBot: VerifiedBot | null;
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
  domain,
  host,
  serverDomains,
  availableOAuthProviders,
  verifiedBot,
  ...appContext
}: AppProviderProps) {
  trpc.user.getSettings.useQuery(undefined, { initialData: settings });
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
  }));

  return <Context.Provider value={state}>{children}</Context.Provider>;
}
