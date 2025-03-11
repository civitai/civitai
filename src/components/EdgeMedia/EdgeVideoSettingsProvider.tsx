import { createContext, useContext } from 'react';

type EdgeVideoSettingsProvider = {
  skipManualPlay?: boolean;
};

const EdgeVideoSettingsContext = createContext<EdgeVideoSettingsProvider | null>(null);

export const useEdgeVideoSettingsContext = () => {
  const context = useContext(EdgeVideoSettingsContext);
  return context;
};

export function EdgeVideoSettingsProvider({
  children,
  ...props
}: { children: React.ReactElement } & EdgeVideoSettingsProvider) {
  return (
    <EdgeVideoSettingsContext.Provider value={{ ...props }}>
      {children}
    </EdgeVideoSettingsContext.Provider>
  );
}
