import clsx from 'clsx';
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import type { HatPlacement } from '~/components/Cosmetics/EventDecoration/event-decoration-placement';
import {
  DEFAULT_HAT_PLACEMENT,
  getHatLayout,
} from '~/components/Cosmetics/EventDecoration/event-decoration-placement';
import type {
  EventDecorationData,
  EventDecorationFit,
} from '~/shared/constants/event-decoration.constants';
import styles from './EventDecorationOverlay.module.scss';

/**
 * Draws an event decoration on a card. Rendered by TwCosmeticWrapper as a sibling of the card,
 * because the card itself is `overflow-hidden` and would crop anything hanging off its edge.
 * An unknown `data.type` draws nothing rather than guessing a position.
 */
export function EventDecorationOverlay({
  decoration,
  placement = DEFAULT_HAT_PLACEMENT,
}: {
  decoration: EventDecorationData;
  placement?: HatPlacement;
}) {
  if (decoration.type === 'hat')
    return <CardHat url={decoration.url} fit={decoration.fit} placement={placement} />;
  return null;
}

const CONFETTI_COLORS = ['#fab005', '#228be6', '#e64980', '#40c057', '#fd7e14', '#be4bdb'];
const CONFETTI_PIECES = 14;

function CardHat({
  url,
  fit,
  placement,
}: {
  url: string;
  fit?: EventDecorationFit;
  placement: HatPlacement;
}) {
  const layout = getHatLayout(placement, fit);
  const [burst, setBurst] = useState(0);

  return (
    <button
      type="button"
      aria-label="Party hat"
      data-event-decoration="hat"
      className={clsx(styles.hat, placement === 'top' && styles.centred)}
      style={{
        left: placement === 'top' ? undefined : layout.left,
        top: layout.top,
        width: layout.width,
        height: layout.height,
        transform: `rotate(${layout.tilt}deg)`,
        transformOrigin: layout.origin,
        ...(placement === 'top' && { marginLeft: -layout.width / 2 }),
      }}
      onClick={(e) => {
        // The card underneath is a link.
        e.preventDefault();
        e.stopPropagation();
        setBurst((x) => x + 1);
      }}
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
      {burst > 0 && (
        <span key={burst} className={styles.confetti} aria-hidden>
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
      )}
    </button>
  );
}
