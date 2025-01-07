import React from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';

type FeatureStatusDictionary = Record<string, { disabled: boolean; message: string }>;

const FeatureStatusCtx = React.createContext<FeatureStatusDictionary | null | undefined>(null);
export function useFeatureStatusContext() {
  const context = React.useContext(FeatureStatusCtx);
  if (!context) return null;
  return context;
}

export function FeatureStatusProvider({ children }: { children: React.ReactNode }) {
  const { data, refetch } = trpc.featureStatus.getFeatureStatuses.useQuery();

  useSignalConnection(SignalMessages.FeatureStatus, refetch);

  return <FeatureStatusCtx.Provider value={data}>{children}</FeatureStatusCtx.Provider>;
}
