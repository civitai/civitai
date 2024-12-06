import React from 'react';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { constants } from '~/server/common/constants';

export function FeedLayout({ children }: { children: React.ReactNode }) {
  // const theme = useMantineTheme();
  return (
    <MasonryProvider
      columnWidth={constants.cardSizes.model}
      maxSingleColumnWidth={450}
      className="z-10 m-0 flex-1"
    >
      {children}
    </MasonryProvider>
  );
}
