import { createContext, useContext } from 'react';
import {
  ColorDomain,
  colorDomains,
  DEFAULT_DOMAIN_SETTINGS,
  DomainSettings,
} from '~/server/common/constants';
import { flagifyBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { trpc } from '~/utils/trpc';

const DomainSettingsCtx = createContext<
  DomainSettings & { isLoading: boolean; allowedNsfwLevelsFlag: number }
>({
  ...DEFAULT_DOMAIN_SETTINGS.green,
  isLoading: true,
  allowedNsfwLevelsFlag: flagifyBrowsingLevel(DEFAULT_DOMAIN_SETTINGS.green.allowedNsfwLevels),
});

export type UseDomainSettingsReturn = ReturnType<typeof useDomainSettings>;
export const useDomainSettings = () => {
  const context = useContext(DomainSettingsCtx);
  return context;
};
export const DomainSettingsProvider = ({ children }: { children: React.ReactNode }) => {
  const { data: domainSettings, isLoading } = trpc.system.getDomainSettings.useQuery(undefined, {
    cacheTime: Infinity,
    staleTime: Infinity,
    retry: 0,
  });

  const _domainSettings = {
    // We need a good way to determine the domain color from here since we don't have access to feature flags.
    ...DEFAULT_DOMAIN_SETTINGS.green,
    ...domainSettings,
  };

  return (
    <DomainSettingsCtx.Provider
      value={{
        ..._domainSettings,
        isLoading,
        allowedNsfwLevelsFlag: flagifyBrowsingLevel(_domainSettings.allowedNsfwLevels),
      }}
    >
      {children}
    </DomainSettingsCtx.Provider>
  );
};
