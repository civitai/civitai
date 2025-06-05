import type { AspectRatio, CardProps } from '@mantine/core';
import React, { forwardRef } from 'react';
import type { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import { CosmeticCard } from '~/components/CardTemplates/CosmeticCard';

type AspectRatio = 'portrait' | 'landscape' | 'square' | 'flat';
const aspectRatioValues: Record<
  AspectRatio,
  { ratio: number; height: number; cssRatio: number; stringRatio: string }
> = {
  portrait: {
    ratio: 7 / 9,
    height: 430,
    // CSS Ratio should be opposite to ratio as it will rely on width.
    cssRatio: 9 / 7,
    stringRatio: '7/9',
  },
  landscape: {
    ratio: 9 / 7,
    height: 300,
    cssRatio: 7 / 9,
    stringRatio: '9/7',
  },
  flat: {
    ratio: 15 / 7,
    height: 300,
    cssRatio: 7 / 15,
    stringRatio: '15/7',
  },
  square: {
    ratio: 1,
    height: 332,
    cssRatio: 1,
    stringRatio: '1',
  },
};

export const FeedCard = forwardRef<HTMLElement, Props>(
  ({ href, children, aspectRatio = 'portrait', className, frameDecoration, onClick }, ref) => {
    const { stringRatio } = aspectRatioValues[aspectRatio];
    const wrapperStyle = { aspectRatio: stringRatio };

    return (
      <CosmeticCard
        cosmetic={frameDecoration?.data}
        cosmeticStyle={frameDecoration?.data ? wrapperStyle : undefined}
        ref={ref}
        style={!frameDecoration?.data ? { aspectRatio: stringRatio } : undefined}
        onClick={onClick}
        href={href}
        className={className}
      >
        {children}
      </CosmeticCard>
    );
  }
);

FeedCard.displayName = 'FeedCard';

type Props = CardProps & {
  children: React.ReactNode;
  href?: string;
  aspectRatio?: AspectRatio;
  onClick?: React.MouseEventHandler;
  useCSSAspectRatio?: boolean;
  frameDecoration?: ContentDecorationCosmetic | null;
};
