import { Badge, Button, Loader } from '@mantine/core';
import { useIsomorphicEffect } from '@mantine/hooks';
import type { IconProps } from '@tabler/icons-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { useEffect, useReducer, useRef, useState } from 'react';
import { NextLink as Link } from '~/components/NextLink/NextLink';

import classes from './HomeStyleSegmentedControl.module.css';

// Progressive density: 0 = comfy, 1 = tight padding, 2 = icon + count (labels
// dropped), 3 = icon only. The active tab always keeps its full label + count.
// Beyond 3 the row falls back to horizontal scroll. Built to mirror the primary
// subnav (HomeContentToggle) — rounded pill buttons, chip-on-hover at full size.
const MAX_DENSITY = 3;

export function HomeStyleSegmentedControl({ data, value: activePath, loading }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastWidthRef = useRef(0);
  const [density, setDensity] = useState(0);
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
    if (density < MAX_DENSITY && root.scrollWidth > root.clientWidth + 1) {
      setDensity((d) => d + 1);
    }
  }, [density, measureNonce, loading, entries.length]);

  return (
    <div ref={containerRef} className={classes.container} data-density={density}>
      <div ref={rootRef} className={clsx(classes.root, 'text-black dark:text-white')}>
        {entries.map(([key, value]) => {
          const active = activePath === key;
          return (
            <Button
              key={key}
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
                <span className={classes.tabLabelInner}>{value.label ?? key}</span>
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
  loading?: boolean;
  data: Record<string, DataItem>;
};
