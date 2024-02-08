import React, { createContext, useContext, useMemo } from 'react';
import {
  parseBitwiseBrowsingLevel,
  sfwBrowsingLevels,
  useBrowsingLevel,
} from '~/components/BrowsingLevel/browsingLevel.utils';

import { NsfwLevel } from '~/server/common/enums';

type BrowsingLevelState = {
  instance: number;
  isSfw: boolean;
  levels: NsfwLevel[];
};
const BrowsingLevelCtx = createContext<BrowsingLevelState | null>(null);
export function useBrowsingLevelContext() {
  const context = useContext(BrowsingLevelCtx);
  if (!context) throw new Error('missing BrowsingLevelProvider');
  return context;
}

export function BrowsingLevelProvider({ children }: { children: React.ReactNode }) {
  const instance = useBrowsingLevel();
  const levels = useMemo(() => parseBitwiseBrowsingLevel(instance), [instance]);
  const isSfw = levels.every((level) => sfwBrowsingLevels.includes(level));

  return (
    <BrowsingLevelCtx.Provider value={{ instance, isSfw, levels }}>
      {children}
    </BrowsingLevelCtx.Provider>
  );
}
