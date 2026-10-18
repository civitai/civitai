import clsx from 'clsx';
import type { CSSProperties } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import styles from './MysteryBox.module.scss';

/**
 * A mystery box: its art for the viewer's team, else a gift box drawn in the team colour. `open`
 * shows the lid off (the art's open image), `lidOff` animates the drawn lid away.
 */
export function MysteryBoxArt({
  art,
  color,
  size,
  open = false,
  shaking = false,
  lidOff = false,
  className,
}: {
  art?: { closed?: string; open?: string } | null;
  color: string;
  /** Displayed width in px. */
  size: number;
  open?: boolean;
  shaking?: boolean;
  lidOff?: boolean;
  className?: string;
}) {
  const src = open ? art?.open ?? art?.closed : art?.closed;
  const motion = clsx(shaking && styles.shake, lidOff && styles.lidOff);

  if (src)
    return (
      <div className={clsx('relative', motion, className)} style={{ width: size }}>
        <EdgeMedia
          src={src}
          width={size * 2}
          className="w-full drop-shadow-[0_6px_10px_rgba(0,0,0,0.35)]"
          alt=""
        />
      </div>
    );

  return (
    <div
      className={clsx(styles.giftBox, motion, className)}
      style={{ width: size, fontSize: size / 7, '--box': color } as CSSProperties}
      aria-hidden
    >
      <div className={styles.body} />
      <div className={styles.ribbon} />
      {!open && <div className={styles.lid} />}
      {!open && <div className={styles.bow} />}
      <div className={styles.mark}>?</div>
    </div>
  );
}
