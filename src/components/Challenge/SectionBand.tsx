import type { ReactNode } from 'react';
import clsx from 'clsx';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import styles from './SectionBand.module.css';

// Full-bleed section band: the outer div spans full content width and paints the band background;
// the inner MasonryContainer re-centers content to the max column width (homepage HomeBlockWrapper shape).
export function SectionBand({
  tone = 'default',
  children,
}: {
  tone?: 'default' | 'alt' | 'your';
  children: ReactNode;
}) {
  return (
    <div className={clsx(tone === 'alt' && styles.alt, tone === 'your' && styles.your)}>
      <MasonryContainer py={32}>{children}</MasonryContainer>
    </div>
  );
}
