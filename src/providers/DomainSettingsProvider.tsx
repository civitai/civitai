import { createContext, useContext, useState, useEffect } from 'react';
import { DomainSettings } from '~/server/common/constants';
import { trpc } from '~/utils/trpc';

const DomainSettingsCtx = createContext<DomainSettings | null>(null);

export type UseDomainSettingsReturn = ReturnType<typeof useDomainSettings>;
export const useDomainSettings = () => {
  const context = useContext(DomainSettingsCtx);
  if (!context) throw new Error('useDomainSettings can only be used inside DomainSettingsCtx');
  return context;
};
export const DomainSettingsProvider = ({
  children,
  settings: initialSettings,
}: {
  children: React.ReactNode;
  settings?: DomainSettings;
}) => {
  const [settings, setSettings] = useState(initialSettings ?? null);

  const { data: domainSettings = {} as DomainSettings } = trpc.system.getDomainSettings.useQuery(
    undefined,
    { cacheTime: Infinity, staleTime: Infinity, retry: 0 }
  );

  useEffect(() => {
    setSettings(domainSettings);
  }, [domainSettings]);

  return <DomainSettingsCtx.Provider value={settings}>{children}</DomainSettingsCtx.Provider>;
};
