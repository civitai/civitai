import React, { useRef } from 'react';
import clsx from 'clsx';
import styles from './CosmeticWrapper.module.scss';
import { CosmeticLights } from '~/components/Cards/components/CosmeticLights';
import { EventDecorationOverlay } from '~/components/Cosmetics/EventDecoration/EventDecorationOverlay';
import {
  getEventDecorationClearLeftCss,
  HAT_PLAIN_CARD_NUDGE,
} from '~/components/Cosmetics/EventDecoration/event-decoration-placement';
import type { EventDecorationData } from '~/shared/constants/event-decoration.constants';
import { isEventDecorationData } from '~/shared/constants/event-decoration.constants';

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
  eventDecoration,
  cardWidth,
  style,
  ...props
}: Omit<React.HTMLProps<HTMLDivElement>, 'children'> & {
  cosmetic?: Cosmetic;
  /** Worn beside the frame. Drawn outside the card, which would crop it. */
  eventDecoration?: EventDecorationData | null;
  /** The card's width in px, for a card narrower than a feed card: the hat shrinks to match. */
  cardWidth?: number;
  children: React.ReactElement;
}) {
  const styleRef = useRef<Record<string, unknown> | undefined>();
  // A reader that predates event decorations can still hand one over as the frame.
  if (isEventDecorationData(cosmetic)) {
    eventDecoration ??= cosmetic;
    cosmetic = undefined;
  }
  const hasFrame = !!cosmetic && !!Object.keys(cosmetic).length;
  if (!hasFrame && !eventDecoration) return children;

  const { cssFrame, texture, border, borderWidth, glow } = cosmetic ?? {};
  // Only these frames are padded (CosmeticWrapper.module.scss); lights or a border alone are not.
  const padded = !!(cssFrame || texture);

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

  return (
    <div
      style={{
        ...styleRef.current,
        ...(eventDecoration && {
          '--event-decoration-clear-left': getEventDecorationClearLeftCss(
            eventDecoration,
            undefined,
            padded ? 0 : HAT_PLAIN_CARD_NUDGE,
            cardWidth
          ),
        }),
        ...style,
      }}
      data-event-decoration={eventDecoration?.type}
      className={clsx(
        // Without a frame the wrapper only positions the decoration: the frame layout's
        // `flex: 1` on the card would override the card's own height and collapse it.
        hasFrame ? styles.wrapper : styles.decorationOnly,
        {
          [styles.border]: border,
          [styles.cssFrame]: cssFrame,
          [styles.texture]: texture,
          [styles.glow]: glow && !border,
        },
        className
      )}
      {...props}
    >
      {hasFrame && <CosmeticLights cosmetic={cosmetic as any} />}
      {children}
      {eventDecoration && (
        <EventDecorationOverlay
          decoration={eventDecoration}
          framed={padded}
          cardWidth={cardWidth}
        />
      )}
    </div>
  );
}
