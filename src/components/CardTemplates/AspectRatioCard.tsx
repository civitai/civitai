import clsx from 'clsx';
import React from 'react';
import { CosmeticCard } from '~/components/CardTemplates/CosmeticCard';
import { ElementInView, useElementInView } from '~/components/IntersectionObserver/ElementInView';
import { useTrackImpression } from '~/components/TrackView/useTrackImpression';
import type { ImpressionTarget } from '~/components/TrackView/useTrackImpression';
import type { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import styles from './AspectRatioCard.module.scss';

type AspectRatio = keyof typeof aspectRatioMap;
const aspectRatioMap = {
  portrait: '7/9',
  landscape: '9/7',
  square: '1',
} as const;

export type AspectRatioCardProps = {
  /**
   * A named ratio, or a raw width/height number to follow the media's own shape.
   * The number form exists so a card can stop cropping — see the remix-of card,
   * which passes the source image's ratio clamped so it never grows past square.
   */
  aspectRatio?: AspectRatio | number;
  cosmetic?: ContentDecorationCosmetic['data'];
  className?: string;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  footerGradient?: boolean;
  render: (props: { inView: boolean }) => React.ReactNode;
  /** Entities this card presents, reported once it has been half visible for a second. */
  impressions?: ImpressionTarget[];
};

export function AspectRatioCard({
  aspectRatio = 'portrait',
  cosmetic,
  className,
  header,
  footer,
  footerGradient,
  render,
  impressions,
}: AspectRatioCardProps) {
  const wrapperStyle = {
    aspectRatio: typeof aspectRatio === 'number' ? aspectRatio : aspectRatioMap[aspectRatio],
  };
  const impressionRef = useTrackImpression<HTMLDivElement>(impressions);

  return (
    <ElementInView
      ref={impressionRef}
      component={CosmeticCard}
      cosmetic={cosmetic}
      cosmeticStyle={cosmetic ? wrapperStyle : undefined}
      style={!cosmetic ? wrapperStyle : undefined}
      className={clsx(className)}
    >
      <AspectRatioCardContent
        render={render}
        header={header}
        footer={footer}
        footerGradient={footerGradient}
      />
    </ElementInView>
  );
}

function AspectRatioCardContent({
  render,
  header,
  footer,
  footerGradient,
}: Pick<AspectRatioCardProps, 'render' | 'header' | 'footer' | 'footerGradient'>) {
  const inView = useElementInView() ?? false;
  return (
    <div className={clsx(styles.content, { [styles.inView]: inView })}>
      {render({ inView })}
      {header && <div className={styles.header}>{header}</div>}
      {footer && (
        <div className={clsx(styles.footer, { [styles.gradient]: footerGradient })}>{footer}</div>
      )}
    </div>
  );
}
