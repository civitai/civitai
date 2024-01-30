import { ContainerProps, useMantineTheme } from '@mantine/core';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import React from 'react';
import { AscendeumAd } from '~/components/Ads/AscendeumAds/AscendeumAd';

export const HomeBlockWrapper = ({ children, showAds, ...props }: Props) => {
  const theme = useMantineTheme();
  return (
    <MasonryContainer {...props}>
      {children}
      {showAds && (
        <AscendeumAd
          adunit="Leaderboard_A"
          style={{ margin: `${theme.spacing.xs}px auto 0` }}
          sizes={{
            [0]: '300x100',
            [theme.breakpoints.md]: '728x90',
            [theme.breakpoints.lg]: ['970x90', '728x90'],
          }}
        />
      )}
    </MasonryContainer>
  );
};

type Props = ContainerProps & { showAds?: boolean };
