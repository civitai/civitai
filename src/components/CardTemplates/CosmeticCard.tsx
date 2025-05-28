import React, { forwardRef } from 'react';
import type { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import { TwCard } from '~/components/TwCard/TwCard';
import { TwCosmeticWrapper } from '~/components/TwCosmeticWrapper/TwCosmeticWrapper';

export const CosmeticCard = forwardRef<HTMLElement, Props>(
  ({ href, children, className, onClick, cosmetic, cosmeticStyle, ...props }, ref) => {
    return (
      <TwCosmeticWrapper cosmetic={cosmetic} style={cosmeticStyle}>
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
};
