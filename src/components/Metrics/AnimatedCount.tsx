import NumberFlow, { type Format } from '@number-flow/react';
import { useEffect, useRef, useState } from 'react';
import classes from './AnimatedCount.module.css';

const compactFormat: Format = {
  notation: 'compact',
  maximumFractionDigits: 1,
};

interface AnimatedCountProps {
  value: number;
  /** Use compact notation (1k, 1.2M). Default: true */
  abbreviate?: boolean;
  className?: string;
}

/**
 * Animated number display with smooth digit transitions, a scale/glow
 * pulse, and a floating "+N" indicator when the value increases.
 *
 * Uses @number-flow/react for digit morphing and CSS animations
 * for visual feedback on value changes.
 */
export function AnimatedCount({ value, abbreviate = true, className }: AnimatedCountProps) {
  const spanRef = useRef<HTMLSpanElement>(null);
  const prevRef = useRef(value);
  const [floatingDelta, setFloatingDelta] = useState<{ key: number; amount: number } | null>(null);
  const deltaKeyRef = useRef(0);

  useEffect(() => {
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
  }, [value]);

  return (
    <span ref={spanRef} className={`${classes.wrapper} ${className ?? ''}`}>
      <NumberFlow
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
