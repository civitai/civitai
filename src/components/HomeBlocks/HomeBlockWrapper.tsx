import { ContainerProps } from '@mantine/core';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import React from 'react';

export const HomeBlockWrapper = ({ children, showAds, ...props }: Props) => {
  return (
    <MasonryContainer {...props}>
      {children}
      {/* {showAds && (
        <Adunit
          style={{ margin: `${theme.spacing.xs}px auto 0` }}
          {...adsRegistry.homePageSectionDivider}
        />
      )} */}
    </MasonryContainer>
  );
};

type Props = ContainerProps & { showAds?: boolean };
