import React from 'react';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { constants } from '~/server/common/constants';
import { AdUnit } from '~/components/Ads/AdUnit';

const maxColumnCount = 7;

export function FeedLayout({ children }: { children: React.ReactNode }) {
  // const theme = useMantineTheme();
  return (
    <IsClient>
      <MasonryProvider
        columnWidth={constants.cardSizes.model}
        maxColumnCount={maxColumnCount}
        maxSingleColumnWidth={450}
        style={{ flex: 1, zIndex: 10 }}
        pb="md"
        className="m-0 peer-[.announcements]:mt-8"
      >
        {/* <AdUnit keys={['Leaderboard_B']} className="justify-center pb-3" /> */}
        {children}
      </MasonryProvider>
    </IsClient>
  );
}
