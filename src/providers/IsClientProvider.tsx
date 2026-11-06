import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';

const IsClientContext = createContext<boolean | null>(null);

const noopSubscribe = () => () => undefined;

/**
 * `false` on the server and during hydration, `true` after. Without a provider above it (a
 * component test harness, say) it reads the same thing from React itself, so it never throws.
 * That is deliberate and holds for every caller: a missing provider gets the hydration-safe
 * client read, not an error.
 */
export const useIsClient = () => {
  const context = useContext(IsClientContext);
  const renderedOnClient = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
  return context ?? renderedOnClient;
};
export const IsClientProvider = ({ children }: { children: React.ReactNode }) => {
  const [isClient, setClient] = useState(false);

  useEffect(() => {
    setClient(true);
  }, []);

  return <IsClientContext.Provider value={isClient}>{children}</IsClientContext.Provider>;
};
