import { useRouter } from 'next/router';
import React from 'react';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { constants } from '~/server/common/constants';
import { SubNav } from './SubNav';
import { Adunit } from '~/components/Ads/AdUnit';
import { adsRegistry } from '~/components/Ads/adsRegistry';
import { BrowsingMode } from '~/server/common/enums';
import { useMantineTheme } from '@mantine/core';

export function FeedLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const theme = useMantineTheme();

  const maxColumnCount = 7;

  const nsfw = router.pathname.includes('articles') ? true : undefined;
  const browsingModeOverride = nsfw ? BrowsingMode.All : undefined;

  return (
    <ScrollArea>
      <SubNav />
      <IsClient>
        <MasonryProvider
          columnWidth={constants.cardSizes.model}
          maxColumnCount={maxColumnCount}
          maxSingleColumnWidth={450}
          style={{ margin: 0, flex: 1, zIndex: 10 }}
          pb="md"
        >
          <Adunit
            browsingModeOverride={browsingModeOverride}
            style={{ margin: `0 auto ${theme.spacing.xs}px`, zIndex: 10 }}
            {...adsRegistry.feedLayoutHeader}
          />
          <MasonryContainer>{children}</MasonryContainer>
        </MasonryProvider>
      </IsClient>
    </ScrollArea>
  );
}
