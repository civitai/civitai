import { useEffect, useRef } from 'react';
import classes from './CustomNumberFlow.module.css';

const formatterCache = new Map<string, Intl.NumberFormat>();
function getFormatter(
  locale: Intl.LocalesArgument | undefined,
  format: Intl.NumberFormatOptions | undefined
) {
  const key = JSON.stringify({ l: locale ?? null, f: format ?? null });
  let f = formatterCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale as Parameters<typeof Intl.NumberFormat>[0], format);
    formatterCache.set(key, f);
  }
  return f;
}

type Item =
  | { id: string; type: 'digit'; n: number; positionFromRight: number }
  | { id: string; type: 'symbol'; char: string; positionFromRight: number };

const DIGIT_RE = /^[0-9]$/;

function parseValue(
  value: number,
  locale: Intl.LocalesArgument | undefined,
  format: Intl.NumberFormatOptions | undefined
): { items: Item[]; formatted: string } {
  const safe = Number.isFinite(value)
    ? Math.max(Math.min(value, Number.MAX_SAFE_INTEGER), Number.MIN_SAFE_INTEGER)
    : 0;
  const formatter = getFormatter(locale, format);
  const formatted = formatter.format(safe);
  const chars = [...formatted];
  const items: Item[] = chars.map((char, i) => {
    const positionFromRight = chars.length - 1 - i;
    if (DIGIT_RE.test(char)) {
      return {
        id: `digit-${positionFromRight}`,
        type: 'digit',
        n: parseInt(char, 10),
        positionFromRight,
      };
    }
    return {
      id: `sym-${char}-${positionFromRight}`,
      type: 'symbol',
      char,
      positionFromRight,
    };
  });
  return { items, formatted };
}

export interface CustomNumberFlowProps {
  /** The number to display. Negative numbers are supported. */
  value: number;
  /**
   * Formatting options passed to `Intl.NumberFormat`. Most common usage:
   *   { notation: 'compact', maximumFractionDigits: 1 }
   */
  format?: Intl.NumberFormatOptions;
  /** Locale for `Intl.NumberFormat`. Defaults to 'en-US'. */
  locale?: Intl.LocalesArgument;
  /** Class applied to the wrapper `<span>`. */
  className?: string;
  /**
   * If true (default), animations are skipped when the user has
   * `prefers-reduced-motion: reduce` set.
   */
  respectMotionPreference?: boolean;
}

// Newline-separated digit stack rendered as a single text node. With
// `white-space: pre` and `line-height: 1em`, the browser lays this out as
// 10 vertically stacked lines, one digit per line — no per-digit element.
const DIGIT_STACK_TEXT = '0\n1\n2\n3\n4\n5\n6\n7\n8\n9';

/**
 * Animated number display that rolls digit columns via CSS transforms.
 * Lightweight drop-in alternative to `@number-flow/react`'s `<NumberFlow>`:
 * no Shadow DOM, no `getBoundingClientRect`, no rAF — pure CSS transitions.
 */
export function CustomNumberFlow({
  value,
  format,
  locale = 'en-US',
  className,
  respectMotionPreference = true,
}: CustomNumberFlowProps) {
  const { items, formatted } = parseValue(value, locale, format);

  const prevIdsRef = useRef<Set<string> | null>(null);
  const enteringIds = new Set<string>();
  if (prevIdsRef.current) {
    for (const item of items) {
      if (!prevIdsRef.current.has(item.id)) enteringIds.add(item.id);
    }
  }

  useEffect(() => {
    prevIdsRef.current = new Set(items.map((i) => i.id));
  });

  const wrapperClass = [
    classes.wrapper,
    respectMotionPreference ? classes.respectMotion : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={wrapperClass}>
      <span className={classes.srOnly}>{formatted}</span>
      {items.map((item) => {
        const isEntering = enteringIds.has(item.id);
        if (item.type === 'digit') {
          const digitClass = `${classes.digit} ${isEntering ? classes.entering : ''}`.trim();
          return (
            <span
              key={item.id}
              className={digitClass}
              data-testid="cnf-digit"
              data-position={item.positionFromRight}
              data-digit={item.n}
              aria-hidden="true"
            >
              <span
                className={classes.stack}
                style={{ ['--cnf-n' as string]: item.n } as React.CSSProperties}
              >
                {DIGIT_STACK_TEXT}
              </span>
            </span>
          );
        }
        const symClass = `${classes.symbol} ${isEntering ? classes.entering : ''}`.trim();
        return (
          <span
            key={item.id}
            className={symClass}
            data-testid="cnf-symbol"
            data-position={item.positionFromRight}
            aria-hidden="true"
          >
            {item.char}
          </span>
        );
      })}
    </span>
  );
}
