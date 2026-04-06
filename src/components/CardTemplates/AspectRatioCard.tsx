import clsx from 'clsx';
import React from 'react';
import { CosmeticCard } from '~/components/CardTemplates/CosmeticCard';
import { useInView } from '~/hooks/useInView';
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
  const { ref, inView } = useInView({ key: cosmetic ? 1 : 0 });

  const wrapperStyle = { aspectRatio: aspectRatioMap[aspectRatio] };

  return (
    <CosmeticCard
      cosmetic={cosmetic}
      cosmeticStyle={cosmetic ? wrapperStyle : undefined}
      ref={ref}
      style={!cosmetic ? wrapperStyle : undefined}
      className={clsx(className)}
    >
      <div className={clsx(styles.content, { [styles.inView]: inView })}>
        {render({ inView })}
        {header && <div className={styles.header}>{header}</div>}
        {footer && (
          <div className={clsx(styles.footer, { [styles.gradient]: footerGradient })}>{footer}</div>
        )}
      </div>
    </CosmeticCard>
  );
}
