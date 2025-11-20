import React, { useState } from 'react';
import type { UserSettingsSchema } from '~/server/schema/user.schema';
import type { RegionInfo } from '~/server/utils/region-blocking';
import type { ColorDomain } from '~/shared/constants/domain.constants';
import { trpc } from '~/utils/trpc';
import { AppContextInstance } from './AppContext';

type AppProviderProps = {
  children: React.ReactNode;
  settings: UserSettingsSchema;
  seed: number;
  canIndex: boolean;
  region: RegionInfo;
  domain: ColorDomain;
};

export function AppProvider({ children, settings, domain, ...appContext }: AppProviderProps) {
  trpc.user.getSettings.useQuery(undefined, { initialData: settings });
  const [state] = useState(() => ({
    ...appContext,
    allowMatureContent: domain !== 'green',
    domain: {
      green: domain === 'green',
      blue: domain === 'blue',
      red: domain === 'red',
    },
  }));

  return <AppContextInstance.Provider value={state}>{children}</AppContextInstance.Provider>;
}

// Re-export for backward compatibility
export { useAppContext } from './AppContext';
export type { AppContext } from './AppContext';
