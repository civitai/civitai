import clsx from 'clsx';
import React from 'react';
import { CosmeticCard } from '~/components/CardTemplates/CosmeticCard';
import { ElementInView, useElementInView } from '~/components/IntersectionObserver/ElementInView';
import type { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import styles from './AspectRatioCard.module.scss';

type AspectRatio = keyof typeof aspectRatioMap;
const aspectRatioMap = {
  portrait: '7/9',
  landscape: '9/7',
  square: '1',
} as const;

export type AspectRatioCardProps = {
  aspectRatio?: AspectRatio;
  cosmetic?: ContentDecorationCosmetic['data'];
  className?: string;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  footerGradient?: boolean;
  render: (props: { inView: boolean }) => React.ReactNode;
};

export function AspectRatioCard({
  aspectRatio = 'portrait',
  cosmetic,
  className,
  header,
  footer,
  footerGradient,
  render,
}: AspectRatioCardProps) {
  const wrapperStyle = { aspectRatio: aspectRatioMap[aspectRatio] };

  return (
    <ElementInView
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
