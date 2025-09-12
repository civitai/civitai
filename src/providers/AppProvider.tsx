import React, { createContext, useContext, useState } from 'react';
import type { UserSettingsSchema } from '~/server/schema/user.schema';
import type { RegionInfo } from '~/server/utils/region-blocking';
import type { ColorDomain } from '~/shared/constants/domain.constants';
import { trpc } from '~/utils/trpc';

type AppProviderProps = {
  seed: number;
  canIndex: boolean;
  region: RegionInfo;
  domain: ColorDomain;
};

type AppContext = AppProviderProps & {
  allowMatureContent: boolean;
};

const Context = createContext<AppContext | null>(null);
export function useAppContext() {
  const context = useContext(Context);
  if (!context) throw new Error('missing AppProvider in tree');
  return context;
}
export function AppProvider({
  children,
  settings,
  ...appContext
}: {
  children: React.ReactNode;
  settings: UserSettingsSchema;
} & AppProviderProps) {
  trpc.user.getSettings.useQuery(undefined, { initialData: settings });
  const [state] = useState<AppContext>(() => {
    return { ...appContext, allowMatureContent: appContext.domain !== 'green' };
  });

  return <Context.Provider value={state}>{children}</Context.Provider>;
}
