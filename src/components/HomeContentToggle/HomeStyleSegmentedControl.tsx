import { Badge, Button, Loader } from '@mantine/core';
import { useIsomorphicEffect } from '@mantine/hooks';
import type { IconProps } from '@tabler/icons-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { useEffect, useReducer, useRef, useState } from 'react';
import { Tooltip } from '~/components/MantineOverlays';
import { NextLink as Link } from '~/components/NextLink/NextLink';

import classes from './HomeStyleSegmentedControl.module.css';

// Progressive density: 0 = comfy, 1 = tight padding, 2 = icon + count (labels
// dropped), 3 = icon only. The active tab always keeps its full label + count.
// Beyond 3 the row falls back to horizontal scroll. Built to mirror the primary
// subnav (HomeContentToggle) — rounded pill buttons, chip-on-hover at full size.
const MAX_DENSITY = 3;
// With `keepLabels` the walk stops after tight padding, so every label stays and the row scrolls.
const MAX_LABELLED_DENSITY = 1;

export function HomeStyleSegmentedControl({ data, value: activePath, loading, keepLabels }: Props) {
  const maxDensity = keepLabels ? MAX_LABELLED_DENSITY : MAX_DENSITY;
  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastWidthRef = useRef(0);
  const [density, setDensity] = useState(0);
  // The row stays `visibility: hidden` until the walk below settles. The server can't measure, so
  // the SSR/hydration paint is always comfy; shown, it collapsed under the cursor the moment
  // hydration (or the counts) landed and the click hit a different tab.
  const [measured, setMeasured] = useState(false);
  const [measureNonce, bumpMeasure] = useReducer((x: number) => x + 1, 0);

  const compact = density >= 2;

  const entries = Object.entries(data).filter(
    ([, value]) => value.disabled === undefined || value.disabled === false
  );

  // Reset to comfy on width change, then the walk-down effect re-tightens. Guard
  // on width only: a height delta (the horizontal scrollbar appearing/vanishing
  // as density changes) would otherwise refire the observer and oscillate.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // Seed with the mount width: the observer's initial callback would otherwise reset to comfy
    // after the walk has settled, and that update lands after paint.
    lastWidthRef.current = el.getBoundingClientRect().width;
    const ro = new ResizeObserver((roEntries) => {
      const width = roEntries[0]?.contentRect.width ?? 0;
      if (width === lastWidthRef.current) return;
      lastWidthRef.current = width;
      setDensity(0);
      bumpMeasure();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Step down one density level while the row overflows. Runs pre-paint so the
  // intermediate levels never flash. Self-terminating: stops once it fits or
  // hits MAX_DENSITY, after which overflow-x:auto scrolls the rest.
  useIsomorphicEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // First load: the counts' final width decides the density, so wait for them.
    if (loading && !measured) return;
    if (density < maxDensity && root.scrollWidth > root.clientWidth + 1) {
      setDensity((d) => d + 1);
    } else if (!measured) {
      setMeasured(true);
    }
  }, [density, maxDensity, measureNonce, loading, entries.length, measured]);

  return (
    <div
      ref={containerRef}
      className={classes.container}
      data-density={density}
      data-measured={measured || undefined}
    >
      <div ref={rootRef} className={clsx(classes.root, 'text-black dark:text-white')}>
        {entries.map(([key, value]) => {
          const active = activePath === key;
          const label = value.label ?? key;
          const button = (
            <Button
              component={Link}
              href={value.url}
              variant="default"
              data-active={active || undefined}
              className={clsx(
                classes.pill,
                'h-8 overflow-visible rounded-full border-none',
                compact ? 'px-2' : 'py-2 pl-3 pr-4',
                active && 'bg-gray-4 dark:bg-dark-4',
                value.className
              )}
              classNames={{
                label: clsx(
                  'flex items-center overflow-visible capitalize',
                  compact ? 'justify-center' : 'gap-2'
                ),
              }}
            >
              {value.icon({ size: 16 })}
              <span className={clsx('text-base font-medium capitalize', classes.tabLabel)}>
                <span className={classes.tabLabelInner}>{label}</span>
              </span>
              {value.count != null && (
                <Badge
                  size="sm"
                  radius="xl"
                  className={classes.tabCount}
                  classNames={{ label: 'overflow-visible' }}
                >
                  {loading ? <Loader size="xs" type="dots" /> : value.count.toLocaleString()}
                </Badge>
              )}
            </Button>
          );

          // A collapsed label is named by a tooltip, not by widening the pill on hover: that
          // reflow slid the neighbouring tabs out from under the cursor mid-click. Always wrapped
          // (disabled when not needed) so a pill turning active doesn't remount and drop focus.
          return (
            <Tooltip
              key={key}
              label={<span className="capitalize">{label}</span>}
              disabled={!compact || active}
              withinPortal
            >
              {button}
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

export type DataItem = {
  url: string;
  icon: (props?: IconProps) => ReactNode;
  disabled?: boolean;
  count?: number;
  label?: string;
  className?: string;
};
type Props = {
  value: string;
  /** Also holds the row hidden on first load until false, so it must settle for every caller. */
  loading?: boolean;
  keepLabels?: boolean;
  data: Record<string, DataItem>;
};
