import type { CSSProperties } from 'react';
import classes from './ImageCSSAspectRatioWrap.module.scss';
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
    <div className={clsx(classes.wrap, className)} style={style}>
      <div className={classes.cover} style={{ paddingBottom: `${aspectRatio * 100}%` }}>
        <div className="size-full">{children}</div>
      </div>
    </div>
  );
};
