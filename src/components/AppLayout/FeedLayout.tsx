import React from 'react';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { constants } from '~/server/common/constants';
import { Adunit } from '~/components/Ads/AdUnit';
import { adsRegistry } from '~/components/Ads/adsRegistry';
import { useMantineTheme } from '@mantine/core';
import { ScrollAreaMain } from '~/components/ScrollArea/ScrollAreaMain';

export function FeedLayout({ children }: { children: React.ReactNode }) {
  const theme = useMantineTheme();

  const maxColumnCount = 7;

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
          <Adunit
            style={{ margin: `0 auto ${theme.spacing.xs}px`, zIndex: 10 }}
            {...adsRegistry.feedLayoutHeader}
          />
          <MasonryContainer>{children}</MasonryContainer>
        </MasonryProvider>
      </IsClient>
    </ScrollAreaMain>
  );
}
