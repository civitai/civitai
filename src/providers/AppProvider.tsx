import React, { createContext, useContext, useState } from 'react';
import type { UserSettingsSchema } from '~/server/schema/user.schema';
import type { RegionInfo } from '~/server/utils/region-blocking';
import type { ColorDomain, ServerDomains } from '~/shared/constants/domain.constants';
import { trpc } from '~/utils/trpc';

type AppProviderProps = {
  children: React.ReactNode;
  settings: UserSettingsSchema;
  seed: number;
  canIndex: boolean;
  region: RegionInfo;
  domain: ColorDomain;
  serverDomains: ServerDomains;
};

type AppContext = {
  seed: number;
  canIndex: boolean;
  region: RegionInfo;
  allowMatureContent: boolean;
  domain: Record<ColorDomain, boolean>;
  serverDomains: ServerDomains;
};
const Context = createContext<AppContext | null>(null);
export function useAppContext() {
  const context = useContext(Context);
  if (!context) throw new Error('missing AppProvider in tree');
  return context;
}

export function useServerDomains(): Record<ColorDomain, string> {
  const { serverDomains } = useAppContext();
  return {
    green: serverDomains.green ?? 'civitai.green',
    blue: serverDomains.blue ?? 'civitai.com',
    red: serverDomains.red ?? 'civitai.red',
  };
}
export function AppProvider({
  children,
  settings,
  domain,
  serverDomains,
  ...appContext
}: AppProviderProps) {
  trpc.user.getSettings.useQuery(undefined, { initialData: settings });
  const [state] = useState(() => ({
    ...appContext,
    allowMatureContent: domain !== 'green',
    domain: {
      green: domain === 'green',
      blue: domain === 'blue',
      red: domain === 'red',
    },
    serverDomains,
  }));

  return <Context.Provider value={state}>{children}</Context.Provider>;
}
