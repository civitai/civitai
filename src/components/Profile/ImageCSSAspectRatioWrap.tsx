import { CSSProperties } from 'react';
import styles from './ImageCSSAspectRatioWrap.module.scss';
import clsx from 'clsx';

export const ImageCSSAspectRatioWrap = ({
  children,
  aspectRatio,
  style,
  className,
}: {
  style?: CSSProperties;
  children: React.ReactNode;
  aspectRatio: number;
  className?: string;
}) => {
  return (
    <div className={clsx(styles.wrap, className)} style={style}>
      <div
        className={styles.cover}
        style={{ '--aspect-ratio': `${(aspectRatio * 100).toFixed(3)}%` } as CSSProperties}
      >
        <div className="size-full">{children}</div>
      </div>
    </div>
  );
};
