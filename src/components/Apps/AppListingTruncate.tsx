import { Badge, Text, Tooltip } from '@mantine/core';
import type { BadgeProps, TextProps } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';

/**
 * App Store Listings (W13) — shared truncation helpers for the store card +
 * detail (Item 1: "tune to fit, tooltip fallback").
 *
 * The store header lays a creator username + kind/category badges into a
 * `wrap="nowrap"` row; the design is tuned so those fit WITHOUT truncation in the
 * common case (adequate `maw`/flex on the columns). These helpers add the last-
 * resort fallback: a Mantine `Tooltip` that reveals the full value on hover ONLY
 * when the text would actually still clip. Whether it clips is a runtime DOM
 * measurement (`scrollWidth`/`scrollHeight` vs the client box) — not a pure
 * decision — so it lives here in a measuring hook rather than the pure view-model.
 */

/**
 * Measure whether the referenced element's content overflows its box (horizontal
 * ellipsis OR vertical line-clamp). Re-measures on element resize so the verdict
 * stays correct as the grid reflows. Returns a ref to attach to the clipping
 * element + the current overflow verdict.
 */
export function useIsOverflowing<T extends HTMLElement = HTMLElement>() {
  const ref = useRef<T>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      setOverflowing(el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight);
    measure();
    // ResizeObserver covers card reflow / responsive breakpoints without a
    // window resize listener (the AuctionPlacementCard OverflowTooltip missed
    // resize — this fixes that gap). Guard for environments without RO
    // (defense-in-depth) — the one-shot measure() above still runs.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, overflowing };
}

/**
 * A `Text` that clips (via `lineClamp`/`truncate` passed through) and reveals its
 * full value in a Tooltip ONLY when it actually clips. Rendered inline (`span`)
 * so it composes inside the creator chip's Group.
 */
export function TruncatedText({
  children,
  tooltipLabel,
  style,
  ...textProps
}: { children: string; tooltipLabel?: string } & TextProps) {
  const { ref, overflowing } = useIsOverflowing<HTMLSpanElement>();
  return (
    <Tooltip
      label={tooltipLabel ?? children}
      disabled={!overflowing}
      withinPortal
      multiline
      maw={320}
      withArrow
    >
      {/* `component="span"` (inline-VALID inside the chip's <a>) + an explicit
          `inline-block` so the element HAS a client box. Mantine's `span` boolean
          prop forces `display: inline`, whose clientWidth/scrollWidth are always 0
          — the overflow measurement then never trips and the Tooltip is dead (and
          the passed `lineClamp` never clips either). Clipping on a single line
          below makes `scrollWidth > clientWidth` a true overflow signal; the inline
          `display` overrides any `-webkit-box` a forwarded `lineClamp` would set. */}
      <Text
        ref={ref}
        component="span"
        {...textProps}
        style={{
          ...style,
          display: 'inline-block',
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          verticalAlign: 'bottom',
        }}
      >
        {children}
      </Text>
    </Tooltip>
  );
}

/**
 * A `Badge` whose label clips to `maw` with an ellipsis and reveals the full label
 * in a Tooltip ONLY when it clips. The inner `<span>` (not Mantine's label
 * wrapper) does the clipping so the overflow is measurable; `leftSection` (the
 * category glyph) is passed through and sits outside the measured span.
 */
export function TruncatedBadge({
  label,
  tooltipLabel,
  ...badgeProps
}: { label: string; tooltipLabel?: string } & Omit<BadgeProps, 'children'>) {
  const { ref, overflowing } = useIsOverflowing<HTMLSpanElement>();
  return (
    <Tooltip
      label={tooltipLabel ?? label}
      disabled={!overflowing}
      withinPortal
      multiline
      maw={320}
      withArrow
    >
      <Badge {...badgeProps} styles={{ label: { overflow: 'visible' }, ...badgeProps.styles }}>
        <span
          ref={ref}
          style={{
            display: 'block',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
      </Badge>
    </Tooltip>
  );
}
