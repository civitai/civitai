import { Box, useMantineTheme } from '@mantine/core';
import React from 'react';
import { AscendeumAd } from '~/components/Ads/AscendeumAds/AscendeumAd';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { constants } from '~/server/common/constants';

export function FeedLayout({ children }: { children: React.ReactNode }) {
  const adStyle: React.CSSProperties = {
    position: 'sticky',
    top: '25%',
  };

  const theme = useMantineTheme();
  const maxColumnCount = 7;
  const xl = 2030;

  return (
    <ScrollArea
      px="md"
      sx={{
        display: 'flex',
        justifyContent: 'space-around',
        gap: theme.spacing.md,
      }}
    >
      <AscendeumAd
        adunit="StickySidebar_A"
        sizes={{
          [theme.breakpoints.md]: '120x600',
          [xl]: '300x600',
        }}
        style={{ ...adStyle }}
      />
      <MasonryProvider
        columnWidth={constants.cardSizes.model}
        maxColumnCount={maxColumnCount}
        maxSingleColumnWidth={450}
        style={{ margin: 0, flex: 1 }}
        px={0}
      >
        <AscendeumAd
          adunit="Leaderboard_A"
          style={{ margin: `0 auto ${theme.spacing.xs}px` }}
          sizes={{
            [0]: '300x100',
            [theme.breakpoints.md]: '728x90',
            [theme.breakpoints.lg]: '970x90',
          }}
        />
        <MasonryContainer>{children}</MasonryContainer>
      </MasonryProvider>
      <AscendeumAd
        adunit="StickySidebar_A"
        sizes={{
          [theme.breakpoints.md]: '120x600',
          [xl]: '300x600',
        }}
        style={{ ...adStyle }}
      />
    </ScrollArea>
  );
}
