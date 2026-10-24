import type { CSSProperties } from 'react';
import styles from './HeroBulbs.module.scss';

/**
 * A string of party bulbs along a hero's top edge, cycling through the given colours. Not the card
 * frame's CosmeticLights: that string runs down a card's sides in a single colour.
 */
export function HeroBulbs({ colors, count = 16 }: { colors: string[]; count?: number }) {
  if (!colors.length) return null;
  return (
    <div aria-hidden className={styles.bulbs} data-testid="hero-bulbs">
      {Array.from({ length: count }, (_, i) => (
        <span key={i} style={{ '--bulb': colors[i % colors.length] } as CSSProperties} />
      ))}
    </div>
  );
}
