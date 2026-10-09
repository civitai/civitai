import React, { forwardRef } from 'react';
import type { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import { TwCard } from '~/components/TwCard/TwCard';
import { TwCosmeticWrapper } from '~/components/TwCosmeticWrapper/TwCosmeticWrapper';
import type { EventDecorationEntity } from '~/components/Cosmetics/EventDecoration/WornHatPopover';
import type { EventDecorationData } from '~/shared/constants/event-decoration.constants';

export const CosmeticCard = forwardRef<HTMLElement, Props>(
  (
    {
      href,
      children,
      className,
      onClick,
      cosmetic,
      cosmeticStyle,
      eventDecoration,
      eventDecorationOn,
      ...props
    },
    ref
  ) => {
    return (
      <TwCosmeticWrapper
        cosmetic={cosmetic}
        eventDecoration={eventDecoration}
        eventDecorationOn={eventDecorationOn}
        style={cosmeticStyle}
      >
        <TwCard ref={ref} onClick={onClick} href={href} className={className} {...props}>
          {children}
        </TwCard>
      </TwCosmeticWrapper>
    );
  }
);

CosmeticCard.displayName = 'CosmeticCard';

type Props = React.HTMLAttributes<HTMLElement> & {
  children: React.ReactNode;
  href?: string;
  onClick?: React.MouseEventHandler;
  cosmetic?: ContentDecorationCosmetic['data'];
  cosmeticStyle?: React.CSSProperties;
  eventDecoration?: EventDecorationData | null;
  /** The content wearing the event decoration, so a click on it can open its stats. */
  eventDecorationOn?: EventDecorationEntity;
};
