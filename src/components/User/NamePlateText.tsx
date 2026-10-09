import type { TextProps } from '@mantine/core';
import { Text } from '@mantine/core';
import clsx from 'clsx';
import type { CSSProperties, ReactNode } from 'react';
import { useAutoplayGifs } from '~/providers/BrowserSettingsProvider';
import type { NamePlateCosmetic } from '~/server/selectors/cosmetic.selector';

type NamePlateData = NamePlateCosmetic['data'] | null | undefined;

export const NAMEPLATE_SWEEP_CLASS = 'animate-nameplate-sweep motion-reduce:animate-none';

/**
 * Mantine Text props for a nameplate. `animated` is not a Text prop, so it is never passed through.
 * An animated gradient repeats its first colour at the end and is drawn twice as wide as the text,
 * so sliding it by one tile loops without a seam.
 */
export function getNamePlateTextProps(data: NamePlateData, { animate }: { animate: boolean }) {
  if (!data) return {};
  const { animated, ...textProps } = data;
  if (!animated || !animate || textProps.variant !== 'gradient' || !textProps.gradient)
    return textProps;

  const { from, to } = textProps.gradient;
  return {
    ...textProps,
    className: NAMEPLATE_SWEEP_CLASS,
    style: {
      '--text-gradient': `linear-gradient(90deg, ${from}, ${to}, ${from})`,
      backgroundSize: '200% 100%',
    } as CSSProperties,
  };
}

/**
 * A username styled by its nameplate. Animated plates stand still when the viewer turned off
 * autoplay, when the caller passes `autoplay={false}`, or under prefers-reduced-motion.
 */
export function NamePlateText({
  nameplate,
  autoplay = true,
  className,
  children,
  ...props
}: Omit<TextProps, 'style'> & {
  nameplate?: NamePlateData;
  autoplay?: boolean;
  children?: ReactNode;
}) {
  const autoplayGifs = useAutoplayGifs();
  const {
    className: plateClassName,
    style,
    ...plateProps
  } = getNamePlateTextProps(nameplate, { animate: autoplay && autoplayGifs }) as TextProps & {
    style?: CSSProperties;
  };

  return (
    <Text {...props} {...plateProps} className={clsx(className, plateClassName)} style={style}>
      {children}
    </Text>
  );
}
