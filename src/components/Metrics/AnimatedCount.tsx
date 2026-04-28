import { useEffect, useRef, useState } from 'react';
import { CustomNumberFlow } from './CustomNumberFlow';
import classes from './AnimatedCount.module.css';

const compactFormat: Intl.NumberFormatOptions = {
  notation: 'compact',
  maximumFractionDigits: 1,
};

const compactFormatter = new Intl.NumberFormat('en-US', compactFormat);
const fullFormatter = new Intl.NumberFormat('en-US');

interface AnimatedCountProps {
  value: number;
  /** Use compact notation (1k, 1.2M). Default: true */
  abbreviate?: boolean;
  className?: string;
  /**
   * When false, renders a plain formatted number instead of the animated
   * NumberFlow custom element. Feed cards pass `false` for offscreen rows
   * to avoid ShadowRoot + rAF cost on hundreds of invisible metrics.
   * Default: true (back-compat).
   */
  animate?: boolean;
}

/**
 * Animated number display with smooth digit transitions, a scale/glow
 * pulse, and a floating "+N" indicator when the value increases.
 *
 * Uses CustomNumberFlow for digit morphing and CSS animations
 * for visual feedback on value changes.
 */
export function AnimatedCount({
  value,
  abbreviate = true,
  className,
  animate = true,
}: AnimatedCountProps) {
  const spanRef = useRef<HTMLSpanElement>(null);
  const prevRef = useRef(value);
  const [floatingDelta, setFloatingDelta] = useState<{ key: number; amount: number } | null>(null);
  const deltaKeyRef = useRef(0);

  useEffect(() => {
    if (!animate) {
      prevRef.current = value;
      return;
    }
    const delta = value - prevRef.current;
    if (delta > 0 && spanRef.current) {
      const el = spanRef.current;
      el.classList.remove(classes.highlight);
      // Force reflow to restart animation if triggered in quick succession
      void el.offsetWidth;
      el.classList.add(classes.highlight);

      // Show floating "+N" indicator
      deltaKeyRef.current += 1;
      setFloatingDelta({ key: deltaKeyRef.current, amount: delta });
    }
    prevRef.current = value;
  }, [value, animate]);

  if (!animate) {
    const formatter = abbreviate ? compactFormatter : fullFormatter;
    return <span className={className}>{formatter.format(value)}</span>;
  }

  return (
    <span ref={spanRef} className={`${classes.wrapper} ${className ?? ''}`}>
      <CustomNumberFlow
        respectMotionPreference={false}
        value={value}
        format={abbreviate ? compactFormat : undefined}
      />
      {floatingDelta && (
        <span
          key={floatingDelta.key}
          className={classes.delta}
          onAnimationEnd={() => setFloatingDelta(null)}
        >
          +{floatingDelta.amount}
        </span>
      )}
    </span>
  );
}
