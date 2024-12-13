import React, { useRef } from 'react';
import clsx from 'clsx';
import styles from './CosmeticWrapper.module.scss';
import { CosmeticLights } from '~/components/Cards/components/CosmeticLights';

type Cosmetic = {
  url?: string;
  offset?: string;
  crop?: string;
  cssFrame?: string;
  glow?: boolean;
  texture?: { url: string; size: { width: number; height: number } };
  border?: string;
  borderWidth?: number;
  color?: string;
  lights?: number;
  brightness?: number;
  type?: string;
};

export function TwCosmeticWrapper({
  children,
  className,
  cosmetic,
  ...props
}: Omit<React.HTMLProps<HTMLDivElement>, 'children'> & {
  cosmetic?: Cosmetic;
  children: React.ReactElement;
}) {
  const styleRef = useRef<Record<string, unknown> | undefined>();
  if (!cosmetic) return children;

  const { cssFrame, texture, border, borderWidth, glow, type } = cosmetic;

  if (true) {
    styleRef.current = {};
    if (texture?.url) styleRef.current['--bgImage'] = texture?.url;
    if (cssFrame) styleRef.current['--bgGradient'] = cssFrame?.replace(';', '');
    if (texture?.size)
      styleRef.current['--bgSize'] = `${texture.size.width}px ${texture.size.height}px, cover`;
    if (border) {
      styleRef.current['--border'] = border;
      styleRef.current['--borderWidth'] = `${borderWidth ?? 1}px`;
    }
  }
  // TODO.holiday - add CosmeticLights

  const content =
    type === 'holiday-frame' ? (
      <CosmeticLights cosmetic={cosmetic as any}>{children}</CosmeticLights>
    ) : (
      children
    );

  return (
    <div
      style={styleRef.current}
      className={clsx(
        'relative rounded-md ',
        {
          [styles.border]: border,
          [styles.cssFrame]: cssFrame,
          [clsx(styles.glow, 'before:rounded-md before:blur-[6px]')]: glow && !border,
        },
        className
      )}
      {...props}
    >
      <CosmeticLights cosmetic={cosmetic as any}>{children}</CosmeticLights>
      {/* {content} */}
    </div>
  );
}
