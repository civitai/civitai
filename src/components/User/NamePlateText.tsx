import type { TextProps } from '@mantine/core';
import { Text } from '@mantine/core';
import clsx from 'clsx';
import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { useAutoplayGifs } from '~/providers/BrowserSettingsProvider';
import type { NamePlateCosmetic } from '~/server/selectors/cosmetic.selector';
import { observeInView } from '~/utils/shared-in-view';

type NamePlateData = NamePlateCosmetic['data'] | null | undefined;

// The sweep repaints the text every frame, so it holds still while the plate is off screen. The
// attribute is set straight on the node (see `useSweepOnlyInView`) to keep scrolling free of renders.
export const NAMEPLATE_SWEEP_CLASS =
  'animate-nameplate-sweep motion-reduce:animate-none data-[offscreen=true]:[animation-play-state:paused]';
const NAMEPLATE_OFFSCREEN_ATTR = 'data-offscreen';

function useSweepOnlyInView(active: boolean) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const stop = observeInView(el, (inView) =>
      el.setAttribute(NAMEPLATE_OFFSCREEN_ATTR, `${!inView}`)
    );
    return () => {
      stop();
      el.removeAttribute(NAMEPLATE_OFFSCREEN_ATTR);
    };
  }, [active]);
  return ref;
}

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

  const ref = useSweepOnlyInView(!!plateClassName);

  return (
    <Text
      {...props}
      {...plateProps}
      ref={ref}
      className={clsx(className, plateClassName)}
      style={style}
    >
      {children}
    </Text>
  );
}
