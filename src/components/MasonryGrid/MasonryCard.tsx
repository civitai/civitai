import { CardProps, createPolymorphicComponent } from '@mantine/core';
import { forwardRef } from 'react';
import { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import { TwCosmeticWrapper } from '~/components/TwCosmeticWrapper/TwCosmeticWrapper';
import { TwCard } from '~/components/TwCard/TwCard';
import clsx from 'clsx';

type MasonryCardProps = CardProps &
  Partial<React.HTMLAttributes<HTMLDivElement>> & {
    height?: number;
    uniform?: boolean;
    frameDecoration?: ContentDecorationCosmetic | null;
    onClick?: () => void;
  };

// TODO - when children not in view, replace child react nodes with static html
const _MasonryCard = forwardRef<HTMLDivElement, MasonryCardProps>(
  (
    {
      height,
      children,
      style,
      uniform,
      frameDecoration,
      className,
      onClick,
      withBorder,
      shadow,
      ...props
    },
    ref
  ) => {
    return (
      <TwCosmeticWrapper cosmetic={frameDecoration?.data}>
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
_MasonryCard.displayName = 'MasonryCard';

export const MasonryCard = createPolymorphicComponent<'div', MasonryCardProps>(_MasonryCard);
