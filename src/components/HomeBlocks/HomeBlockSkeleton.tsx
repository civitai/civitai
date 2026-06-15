import { AspectRatio, Box, Skeleton } from '@mantine/core';
import React from 'react';
import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import classes from '~/components/HomeBlocks/HomeBlock.module.scss';

const ITEMS_PER_ROW = 7;

/**
 * Layout-stable placeholder for a single grid-style home block (Collection /
 * FeaturedCollections / FeaturedModelVersion). It reproduces the SAME markup the
 * real blocks render while their own query is loading — a header bar plus a
 * `classes.grid` of `rows × ITEMS_PER_ROW` AspectRatio 7/9 cards — so swapping in
 * the real block (which shares the grid geometry) does not shift siblings.
 *
 * Rendered deterministically (no client-only / useInView state) so SSR and the
 * first client render agree (no hydration mismatch).
 */
export function HomeBlockSkeleton({ rows = 2 }: { rows?: number }) {
  const count = ITEMS_PER_ROW * rows;
  return (
    <HomeBlockWrapper py={32}>
      {/* aria-hidden: the placeholder cards are decorative; keep the empty
          skeleton nodes out of the screen-reader tree during load. */}
      <div aria-hidden style={{ '--count': count, '--rows': rows } as React.CSSProperties}>
        <Box mb="md">
          <Skeleton height={32} width={220} radius="sm" />
        </Box>
        <div className={classes.grid}>
          {Array.from({ length: count }).map((_, index) => (
            <AspectRatio ratio={7 / 9} key={index} className="m-2">
              <Skeleton width="100%" />
            </AspectRatio>
          ))}
        </div>
      </div>
    </HomeBlockWrapper>
  );
}

/**
 * A full-page home placeholder: a handful of grid-block skeletons matching the
 * typical home layout (~6 blocks). Used in place of the absolute-positioned
 * PageLoader (which reserves zero layout height) while the home-block LIST query
 * loads, so the content container is present at ~final height on first paint
 * instead of popping in from 0 (the dominant home-page CLS source).
 */
export function HomeBlocksSkeleton({ count = 6 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, index) => (
        <HomeBlockSkeleton key={index} />
      ))}
    </>
  );
}
