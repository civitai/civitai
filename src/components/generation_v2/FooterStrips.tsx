import type { MouseEvent, ReactNode } from 'react';
import { useMobileGenerator } from '~/hooks/useMobileGenerator';
import classes from './FooterStrips.module.scss';

/**
 * In the mobile generator the footer's alerts become one-line strips that open on tap, in a stack
 * that scrolls so none pushes the Generate row off screen; `data-strip-full` keeps an alert in full.
 * Elsewhere children render unchanged.
 */
export function FooterStrips({ children }: { children: ReactNode }) {
  const mobileGenerator = useMobileGenerator();
  if (!mobileGenerator) return <>{children}</>;
  return (
    <div className={classes.strips} data-strips onClick={toggleStrip}>
      {children}
    </div>
  );
}

/** For the footer the strips sit in: a stack at its top meets its rounded top edge. */
export const footerStripsFrame = classes.frame;

function toggleStrip(e: MouseEvent<HTMLDivElement>) {
  const target = e.target as HTMLElement;
  // The strip's own buttons and links act; a tap anywhere else opens or folds its text.
  if (target.closest('a, button, input, label')) return;
  let strip: HTMLElement | null = target;
  while (strip && strip.parentElement !== e.currentTarget) strip = strip.parentElement;
  if (!strip) return;
  strip.toggleAttribute('data-expanded');
}
