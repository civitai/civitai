import React from 'react';
import { RenderAdUnitOutstream } from '~/components/Ads/AdUnitOutstream';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { constants, DEFAULT_EDGE_IMAGE_WIDTH } from '~/server/common/constants';

export function FeedLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <MasonryProvider
        columnWidth={constants.cardSizes.model}
        maxSingleColumnWidth={DEFAULT_EDGE_IMAGE_WIDTH}
        className="z-10 m-0 flex-1"
      >
        {children}
      </MasonryProvider>
      <RenderAdUnitOutstream minContainerWidth={3200} />
    </>
  );
}
