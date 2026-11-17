import clsx from 'clsx';
import { useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import { sliderZone } from '~/components/generation_v2/inputs/slider-zone';
import {
  ratioOf,
  snapToStep,
  valueAtRatio,
} from '~/components/generation_v2/inputs/touch-slider.utils';
import classes from './TouchSlider.module.scss';

/** Horizontal travel, in px, before a touch counts as a drag rather than the start of a scroll. */
const DRAG_THRESHOLD = 6;

export interface TouchSliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Fires while dragging, for display. */
  onChange: (value: number) => void;
  /** Fires once on release, tap or key press: the value to commit. */
  onChangeEnd: (value: number) => void;
  recommended?: { min: number; max: number };
  disabled?: boolean;
  label?: string;
  formatValue?: (value: number) => string;
  className?: string;
}

/**
 * A slider for touch screens. The whole 44px band is the target, and a drag only starts once the
 * finger moves sideways (`touch-action: pan-y`), so a vertical swipe that starts on the slider
 * still scrolls the form. Mantine's Slider cancels every touch that starts on it, so it can't.
 */
export function TouchSlider({
  value,
  min,
  max,
  step,
  onChange,
  onChangeEnd,
  recommended,
  disabled,
  label,
  formatValue = String,
  className,
}: TouchSliderProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ id: number; x: number; y: number; dragging: boolean } | null>(null);
  const latest = useRef(value);
  const [dragging, setDragging] = useState(false);
  const range = { min, max, step };
  const zone = sliderZone({ min, max }, recommended);

  const moveTo = (clientX: number) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect?.width) return;
    const next = valueAtRatio((clientX - rect.left) / rect.width, range);
    if (next !== latest.current) {
      latest.current = next;
      onChange(next);
    }
  };

  const end = () => {
    gesture.current = null;
    setDragging(false);
    onChangeEnd(latest.current);
  };

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || gesture.current) return;
    latest.current = value;
    const isMouse = e.pointerType === 'mouse';
    gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, dragging: isMouse };
    if (isMouse) {
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
      moveTo(e.clientX);
    }
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    if (!g.dragging) {
      const dx = Math.abs(e.clientX - g.x);
      const dy = Math.abs(e.clientY - g.y);
      if (dx < DRAG_THRESHOLD || dx <= dy) return;
      g.dragging = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
    }
    moveTo(e.clientX);
  };

  const handlePointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    if (!g.dragging) moveTo(e.clientX);
    end();
  };

  // The browser cancels the pointer when it takes the gesture over as a scroll.
  const handlePointerCancel = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    if (g.dragging) end();
    else gesture.current = null;
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const unit = step || (max - min) / 100;
    const delta: Record<string, number> = {
      ArrowRight: unit,
      ArrowUp: unit,
      ArrowLeft: -unit,
      ArrowDown: -unit,
      PageUp: unit * 10,
      PageDown: -unit * 10,
    };
    let next: number | undefined;
    if (e.key in delta) next = snapToStep(value + delta[e.key], range);
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    if (next === undefined) return;
    e.preventDefault();
    latest.current = next;
    onChange(next);
    onChangeEnd(next);
  };

  return (
    <div
      ref={rootRef}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={formatValue(value)}
      aria-disabled={disabled || undefined}
      className={clsx(
        classes.root,
        zone && classes.zoned,
        disabled && classes.disabled,
        dragging && classes.dragging,
        className
      )}
      style={{ '--p': ratioOf(value, range) } as CSSProperties}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onKeyDown={handleKeyDown}
    >
      <div className={classes.track}>
        {zone ? (
          <div
            className={classes.zone}
            style={{ left: `${zone.start}%`, width: `${zone.end - zone.start}%` }}
          />
        ) : (
          <div className={classes.fill} />
        )}
      </div>
      <div className={classes.thumb}>
        {dragging && <span className={classes.bubble}>{formatValue(value)}</span>}
      </div>
    </div>
  );
}
