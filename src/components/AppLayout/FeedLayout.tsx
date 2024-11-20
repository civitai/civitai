import React from 'react';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { constants } from '~/server/common/constants';

const maxColumnCount = 7;

export function FeedLayout({ children }: { children: React.ReactNode }) {
  // const theme = useMantineTheme();
  return (
    <MasonryProvider
      columnWidth={constants.cardSizes.model}
      maxColumnCount={maxColumnCount}
      maxSingleColumnWidth={450}
      className="z-10 m-0 flex-1 peer-[.announcements]:mt-8"
    >
      {children}
    </MasonryProvider>
  );
}
