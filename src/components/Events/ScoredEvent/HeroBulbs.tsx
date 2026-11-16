import type { CSSProperties } from 'react';
import { useEffect, useRef } from 'react';
import { observeInView } from '~/utils/shared-in-view';
import styles from './HeroBulbs.module.scss';

/**
 * A string of party bulbs along a hero's top edge, cycling through the given colours. Not the card
 * frame's CosmeticLights: that string runs down a card's sides in a single colour.
 */
export function HeroBulbs({ colors, count = 16 }: { colors: string[]; count?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const hasColors = colors.length > 0;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stop = observeInView(el, (inView) => el.setAttribute('data-offscreen', `${!inView}`));
    return () => {
      stop();
      el.removeAttribute('data-offscreen');
    };
  }, [hasColors]);

  if (!hasColors) return null;
  return (
    <div ref={ref} aria-hidden className={styles.bulbs} data-testid="hero-bulbs">
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          style={
            {
              '--bulb': colors[i % colors.length],
              '--bulb-sm': colors[Math.floor(i / 2) % colors.length],
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
