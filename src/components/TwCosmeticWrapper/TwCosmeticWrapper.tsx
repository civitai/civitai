import React, { CSSProperties, useRef } from 'react';
import clsx from 'clsx';

type Cosmetic = {
  url?: string;
  offset?: string;
  crop?: string;
  cssFrame?: string;
  glow?: boolean;
  texture?: { url: string; size: { width: number; height: number } };
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
  const styleRef = useRef<CSSProperties | undefined>();
  if (!cosmetic) return children;

  if (!styleRef.current && cosmetic) {
    const { cssFrame, texture } = cosmetic;
    const frameBackground = [texture?.url, cssFrame].filter(Boolean).join(', ');
    if (frameBackground.length > 0)
      styleRef.current = {
        '--bgImage': texture?.url,
        '--bgGradient': cssFrame?.replace(';', ''),
        '--bgSize': texture?.size
          ? `${texture.size.width}px ${texture.size.height}px, cover`
          : undefined,
      } as CSSProperties;
  }

  return (
    <div
      style={styleRef.current}
      className={clsx(
        cosmetic &&
          'rounded-md bg-[image:var(--bgImage,var(--bgGradient)),var(--bgGradient)] bg-[length:var(--bgSize)] p-[6px]',
        cosmetic?.glow &&
          'relative before:absolute before:left-0 before:top-0 before:size-full before:bg-[image:var(--bgGradient)] before:blur-[6px]',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}
