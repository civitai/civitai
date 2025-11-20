import { createContext, useContext } from 'react';
import type { RegionInfo } from '~/server/utils/region-blocking';
import type { ColorDomain } from '~/shared/constants/domain.constants';

export type AppContext = {
  seed: number;
  canIndex: boolean;
  region: RegionInfo;
  allowMatureContent: boolean;
  domain: Record<ColorDomain, boolean>;
};

export const AppContextInstance = createContext<AppContext | null>(null);

export function useAppContext() {
  const context = useContext(AppContextInstance);
  if (!context) throw new Error('missing AppProvider in tree');
  return context;
}
