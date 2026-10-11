import type { CardProps } from '@mantine/core';
import { forwardRef } from 'react';
import type { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import { TwCosmeticWrapper } from '~/components/TwCosmeticWrapper/TwCosmeticWrapper';
import { TwCard } from '~/components/TwCard/TwCard';
import clsx from 'clsx';
import type { EventDecorationData } from '~/shared/constants/event-decoration.constants';

type MasonryCardProps = CardProps &
  Partial<React.HTMLAttributes<HTMLDivElement>> & {
    height?: number;
    uniform?: boolean;
    frameDecoration?: ContentDecorationCosmetic | null;
    eventDecoration?: EventDecorationData | null;
    /** The card's width in px, for a card narrower than a feed card: the hat shrinks to match. */
    cardWidth?: number;
    onClick?: () => void;
  };

// TODO - when children not in view, replace child react nodes with static html
export const MasonryCard = forwardRef<HTMLDivElement, MasonryCardProps>(
  (
    {
      height,
      children,
      style,
      uniform,
      frameDecoration,
      eventDecoration,
      cardWidth,
      className,
      onClick,
      withBorder,
      shadow,
      ...props
    },
    ref
  ) => {
    return (
      <TwCosmeticWrapper
        cosmetic={frameDecoration?.data}
        eventDecoration={eventDecoration}
        cardWidth={cardWidth}
      >
        {/* <CosmeticLights frameDecoration={frameDecoration} /> */}
        <TwCard
          ref={ref as any}
          style={{ height, ...style }}
          className={clsx(className, { ['border']: withBorder, ['shadow']: shadow !== undefined })}
          onClick={onClick}
        >
          {children}
        </TwCard>
      </TwCosmeticWrapper>
    );
  }
);
MasonryCard.displayName = 'MasonryCard';
