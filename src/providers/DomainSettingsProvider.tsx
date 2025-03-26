import { createContext, useContext } from 'react';
import { useDomainColor } from '~/hooks/useDomainColor';
import { DEFAULT_DOMAIN_SETTINGS, DomainSettings } from '~/server/common/constants';
import { trpc } from '~/utils/trpc';

const DomainSettingsCtx = createContext<DomainSettings & { isLoading: boolean }>({
  ...DEFAULT_DOMAIN_SETTINGS.green,
  isLoading: true,
});

export type UseDomainSettingsReturn = ReturnType<typeof useDomainSettings>;
export const useDomainSettings = () => {
  const context = useContext(DomainSettingsCtx);
  return context;
};
export const DomainSettingsProvider = ({ children }: { children: React.ReactNode }) => {
  const color = useDomainColor();
  const { data: domainSettings, isLoading } = trpc.system.getDomainSettings.useQuery(undefined, {
    cacheTime: Infinity,
    staleTime: Infinity,
    retry: 0,
  });

  return (
    <DomainSettingsCtx.Provider
      value={{
        ...DEFAULT_DOMAIN_SETTINGS[color ?? 'green'],
        ...domainSettings,
        isLoading,
      }}
    >
      {children}
    </DomainSettingsCtx.Provider>
  );
};
