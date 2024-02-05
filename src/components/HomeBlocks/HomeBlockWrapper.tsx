import { ContainerProps, useMantineTheme } from '@mantine/core';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import React from 'react';
import { Adunit } from '~/components/Ads/AdUnit';
import { adsRegistry } from '~/components/Ads/adsRegistry';

export const HomeBlockWrapper = ({ children, showAds, ...props }: Props) => {
  const theme = useMantineTheme();
  return (
    <MasonryContainer {...props}>
      {children}
      {showAds && (
        <Adunit
          style={{ margin: `${theme.spacing.xs}px auto 0` }}
          {...adsRegistry.homePageSectionDivider}
        />
      )}
    </MasonryContainer>
  );
};

type Props = ContainerProps & { showAds?: boolean };
