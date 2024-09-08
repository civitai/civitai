import React from 'react';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { constants } from '~/server/common/constants';
import { ScrollAreaMain } from '~/components/ScrollArea/ScrollAreaMain';
import { AdUnit } from '~/components/Ads/AdUnit';

const maxColumnCount = 7;

export function FeedLayout({ children }: { children: React.ReactNode }) {
  // const theme = useMantineTheme();
  return (
    <ScrollAreaMain>
      <IsClient>
        <MasonryProvider
          columnWidth={constants.cardSizes.model}
          maxColumnCount={maxColumnCount}
          maxSingleColumnWidth={450}
          style={{ margin: 0, flex: 1, zIndex: 10 }}
          pb="md"
        >
          <AdUnit keys={['Leaderboard_B']} className="justify-center pb-3" />
          {children}
        </MasonryProvider>
      </IsClient>
    </ScrollAreaMain>
  );
}
