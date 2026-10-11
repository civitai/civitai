import clsx from 'clsx';
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import type { HatPlacement } from '~/components/Cosmetics/EventDecoration/event-decoration-placement';
import {
  DEFAULT_HAT_PLACEMENT,
  getHatLayout,
  HAT_PLAIN_CARD_NUDGE,
  hatShiftCss,
} from '~/components/Cosmetics/EventDecoration/event-decoration-placement';
import type {
  EventDecorationData,
  EventDecorationFit,
} from '~/shared/constants/event-decoration.constants';
import type { EventDecorationEntity } from '~/components/Cosmetics/EventDecoration/WornHatPopover';
import { WornHatPopover } from '~/components/Cosmetics/EventDecoration/WornHatPopover';
import styles from './EventDecorationOverlay.module.scss';

/**
 * Draws an event decoration on a card. Rendered by TwCosmeticWrapper as a sibling of the card,
 * because the card itself is `overflow-hidden` and would crop anything hanging off its edge.
 * An unknown `data.type` draws nothing rather than guessing a position.
 */
export function EventDecorationOverlay({
  decoration,
  placement = DEFAULT_HAT_PLACEMENT,
  framed = false,
  cardWidth,
  wornOn,
}: {
  decoration: EventDecorationData;
  placement?: HatPlacement;
  /** Inside a frame, whose padding already carries the hat out past the picture. */
  framed?: boolean;
  /** The card's width in px; on a card narrower than a feed card the hat shrinks to match. */
  cardWidth?: number;
  /** The content wearing it. A click then also opens its stats; without, it only bursts. */
  wornOn?: EventDecorationEntity;
}) {
  if (decoration.type === 'hat')
    return (
      <CardHat
        url={decoration.url}
        fit={decoration.fit}
        placement={placement}
        framed={framed}
        cardWidth={cardWidth}
        event={decoration.event}
        wornOn={wornOn}
      />
    );
  return null;
}

const CONFETTI_COLORS = ['#fab005', '#228be6', '#e64980', '#40c057', '#fd7e14', '#be4bdb'];
const CONFETTI_PIECES = 14;

function CardHat({
  url,
  fit,
  placement,
  framed,
  cardWidth,
  event,
  wornOn,
}: {
  url: string;
  fit?: EventDecorationFit;
  placement: HatPlacement;
  framed: boolean;
  cardWidth?: number;
  event: string;
  wornOn?: EventDecorationEntity;
}) {
  const [burst, setBurst] = useState(0);
  const [opened, setOpened] = useState(false);
  const layout =
    placement === 'corner'
      ? getHatLayout(placement, fit, Infinity, framed ? 0 : HAT_PLAIN_CARD_NUDGE, cardWidth)
      : getHatLayout(placement, fit, undefined, 0, cardWidth);
  // Moved into the card only as far as its container's room requires, which only CSS knows.
  const fitInto = (at: number, reach: number) =>
    placement === 'corner' ? `calc(${at}px + ${hatShiftCss(reach)})` : at;
  const box = {
    left: fitInto(layout.left, layout.reach.left),
    top: fitInto(layout.top, layout.reach.top),
    width: layout.width,
    height: layout.height,
    transform: `rotate(${layout.tilt}deg)`,
    transformOrigin: layout.origin,
    '--hat-grow': layout.grow,
  } as CSSProperties;
  const grows = placement === 'corner' && styles.grows;

  const hat = (
    <button
      type="button"
      aria-label="Party hat"
      data-event-decoration="hat"
      className={clsx(styles.hat, grows)}
      style={box}
      onClick={(e) => {
        // The card underneath is a link.
        e.preventDefault();
        e.stopPropagation();
        setBurst((x) => x + 1);
        if (wornOn) setOpened((x) => !x);
      }}
      onKeyDown={(e) => {
        // The popover's own Escape handler sits on its dropdown, but a click leaves focus here.
        if (e.key !== 'Escape' || !opened) return;
        e.stopPropagation();
        setOpened(false);
      }}
      // A Mantine Modal around the card closes on Escape from a window listener unless told not to.
      data-mantine-stop-propagation={opened || undefined}
    >
      <EdgeMedia
        src={url}
        type="image"
        name="party hat"
        alt=""
        width={layout.width * 2}
        original={false}
        className={styles.art}
        optimized
      />
      {/* Takes the clicks in the hat's shape; clipping the button would cut its shadow and ring. */}
      <span className={styles.hit} style={{ clipPath: layout.hitArea }} />
    </button>
  );

  return (
    <>
      {wornOn ? (
        <WornHatPopover event={event} wornOn={wornOn} opened={opened} onChange={setOpened}>
          {hat}
        </WornHatPopover>
      ) : (
        hat
      )}
      {burst > 0 && (
        // Beside the button rather than in it, so the hat's clip does not cut the burst short.
        <span key={burst} className={clsx(styles.burst, grows)} style={box} aria-hidden>
          <span className={styles.confetti}>
            {Array.from({ length: CONFETTI_PIECES }, (_, i) => {
              const angle = (i / CONFETTI_PIECES) * Math.PI * 2;
              const distance = 26 + (i % 3) * 8;
              return (
                <span
                  key={i}
                  style={
                    {
                      '--dx': `${Math.cos(angle) * distance}px`,
                      '--dy': `${Math.sin(angle) * distance - 10}px`,
                      background: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
                    } as CSSProperties
                  }
                />
              );
            })}
          </span>
        </span>
      )}
    </>
  );
}
