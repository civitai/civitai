import { AspectRatio, Card, CardProps } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import React, { forwardRef } from 'react';
import { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import { useFrameStyles } from '~/components/Cards/Cards.styles';
import { CosmeticLights } from '~/components/Cards/components/CosmeticLights';
import { TwCard, TwCardAnchor } from '~/components/TwCard/TwCard';
import { TwCosmeticWrapper } from '~/components/TwCosmeticWrapper/TwCosmeticWrapper';
import clsx from 'clsx';

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

    return (
      <TwCosmeticWrapper cosmetic={frameDecoration?.data}>
        {/* <CosmeticLights frameDecoration={frameDecoration} /> */}
        {href ? (
          <TwCardAnchor
            ref={ref as any}
            style={{ aspectRatio: stringRatio }}
            href={href}
            className={className}
            onClick={onClick}
          >
            {children}
          </TwCardAnchor>
        ) : (
          <TwCard ref={ref as any} style={{ aspectRatio: stringRatio }}>
            {children}
          </TwCard>
        )}
      </TwCosmeticWrapper>
    );
  }
);

FeedCard.displayName = 'FeedCard';

type Props = CardProps & {
  children: React.ReactNode;
  href?: string;
  aspectRatio?: AspectRatio;
  onClick?: React.MouseEventHandler<HTMLAnchorElement>;
  useCSSAspectRatio?: boolean;
  frameDecoration?: ContentDecorationCosmetic | null;
};
