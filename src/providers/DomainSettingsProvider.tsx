import { createContext, useContext, useState, useEffect } from 'react';
import { useDomainColor } from '~/hooks/useDomainColor';
import { DEFAULT_DOMAIN_SETTINGS, DomainSettings } from '~/server/common/constants';
import { trpc } from '~/utils/trpc';

const DomainSettingsCtx = createContext<DomainSettings | null>(null);

export type UseDomainSettingsReturn = ReturnType<typeof useDomainSettings>;
export const useDomainSettings = () => {
  const context = useContext(DomainSettingsCtx);
  return context;
};
export const DomainSettingsProvider = ({ children }: { children: React.ReactNode }) => {
  const { data: domainSettings } = trpc.system.getDomainSettings.useQuery(undefined, {
    cacheTime: Infinity,
    staleTime: Infinity,
    retry: 0,
  });

  return (
    <DomainSettingsCtx.Provider value={domainSettings ?? DEFAULT_DOMAIN_SETTINGS.green}>
      {children}
    </DomainSettingsCtx.Provider>
  );
};
