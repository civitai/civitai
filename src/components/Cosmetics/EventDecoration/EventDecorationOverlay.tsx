import clsx from 'clsx';
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import type {
  HatAllowance,
  HatPlacement,
} from '~/components/Cosmetics/EventDecoration/event-decoration-placement';
import {
  DEFAULT_HAT_PLACEMENT,
  getEventDecorationClearLeftCss,
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
import { LayeredHat, useHatLayer } from '~/components/Cosmetics/EventDecoration/HatLayer';
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
  allowance,
  wornOn,
}: {
  decoration: EventDecorationData;
  placement?: HatPlacement;
  /** Inside a frame, whose padding already carries the hat out past the picture. */
  framed?: boolean;
  /** The card's width in px; on a card narrower than a feed card the hat shrinks to match. */
  cardWidth?: number;
  /** How far past the card's top and left a `corner` hat may reach, where the container is known. */
  allowance?: HatAllowance;
  /** The content wearing it. A click then also opens its stats; without, it only bursts. */
  wornOn?: EventDecorationEntity;
}) {
  const hatLayer = useHatLayer();
  if (decoration.type !== 'hat') return null;
  const hat = (width?: number) => (
    <CardHat
      url={decoration.url}
      fit={decoration.fit}
      placement={placement}
      framed={framed}
      cardWidth={cardWidth ?? width}
      allowance={allowance}
      event={decoration.event}
      wornOn={wornOn}
    />
  );
  if (hatLayer?.layer && placement === 'corner' && allowance === undefined)
    return (
      <LayeredHat layer={hatLayer.layer} hidden={hatLayer.moving} version={hatLayer.version}>
        {({ width }) => hat(width)}
      </LayeredHat>
    );
  return hat();
}

export type WornDecoration = { data: EventDecorationData } | null | undefined;

/**
 * One image's own hat, in its media's corner. The media clips at its edge, so the hat stays
 * inside it unless the caller passes an `allowance` or an ancestor's hat layer carries it past
 * the corner.
 */
export function ImageMediaHat({
  imageId,
  decoration,
  cardWidth,
  allowance,
}: {
  imageId: number;
  decoration: WornDecoration;
  /** The media's drawn width; a picture narrower than a feed card wears the hat scaled down. */
  cardWidth?: number;
  /** How far past the media's top and left the hat may reach; without it, none. */
  allowance?: HatAllowance;
}) {
  const inLayer = useInHatLayer();
  if (!decoration) return null;
  return (
    <EventDecorationOverlay
      decoration={decoration.data}
      placement={allowance === undefined && !inLayer ? 'inside' : 'corner'}
      allowance={allowance}
      cardWidth={cardWidth}
      wornOn={{ entityType: 'Image', entityId: imageId }}
    />
  );
}

/** Whether an ancestor's hat layer carries the hats here, so they hang past the media's corner. */
export const useInHatLayer = () => !!useHatLayer()?.layer;

/** Steps the media's top-left badges clear of its ImageMediaHat, which `inLayer` puts on the corner. */
export function imageMediaHatClearLeft(decoration: WornDecoration, inLayer = false) {
  if (!decoration) return undefined;
  return {
    '--event-decoration-clear-left': inLayer
      ? getEventDecorationClearLeftCss(decoration.data, 'corner', HAT_PLAIN_CARD_NUDGE)
      : getEventDecorationClearLeftCss(decoration.data, 'inside'),
  } as CSSProperties;
}

const CONFETTI_COLORS = ['#fab005', '#228be6', '#e64980', '#40c057', '#fd7e14', '#be4bdb'];
const CONFETTI_PIECES = 14;

function CardHat({
  url,
  fit,
  placement,
  framed,
  cardWidth,
  allowance,
  event,
  wornOn,
}: {
  url: string;
  fit?: EventDecorationFit;
  placement: HatPlacement;
  framed: boolean;
  cardWidth?: number;
  allowance?: HatAllowance;
  event: string;
  wornOn?: EventDecorationEntity;
}) {
  const [burst, setBurst] = useState(0);
  const [opened, setOpened] = useState(false);
  const layout =
    placement === 'corner'
      ? getHatLayout(
          placement,
          fit,
          allowance ?? Infinity,
          framed ? 0 : HAT_PLAIN_CARD_NUDGE,
          cardWidth
        )
      : getHatLayout(placement, fit, undefined, 0, cardWidth);
  // Moved into the card only as far as its container's room requires, which only CSS knows,
  // unless the caller measured that room.
  const fitInto = (at: number, reach: number) =>
    placement === 'corner' && allowance === undefined
      ? `calc(${at}px + ${hatShiftCss(reach)})`
      : at;
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
        // Safari and Firefox do not focus a clicked button, so Escape would target the page and a
        // modal around the card would close instead of the popover.
        e.currentTarget.focus();
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
