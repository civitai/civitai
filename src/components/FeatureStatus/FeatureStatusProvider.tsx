import React from 'react';
import { trpc } from '~/utils/trpc';

type FeatureStatusDictionary = Record<string, { disabled?: boolean; message?: string }>;

const FeatureStatusCtx = React.createContext<FeatureStatusDictionary | null>(null);

export function FeatureStatusProvider({
  children,
  feature,
}: {
  children: React.ReactNode;
  feature: string | string[];
}) {
  const { data } = trpc.featureStatus.getFeatureStatuses.useQuery({ feature });
  const featureStatusDictionary = data
    ? data.reduce<FeatureStatusDictionary>(
        (acc, { feature, disabled, message }) => ({ ...acc, [feature]: { disabled, message } }),
        {}
      )
    : {};

  return (
    <FeatureStatusCtx.Provider value={featureStatusDictionary}>
      {children}
    </FeatureStatusCtx.Provider>
  );
}
