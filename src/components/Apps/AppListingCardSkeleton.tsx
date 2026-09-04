import { Box, Card, Group, Skeleton, Stack, Text } from '@mantine/core';
import { useRef, useState } from 'react';
import gridClasses from '~/components/Apps/AppListingsMarketplaceBody.module.scss';
import {
  LISTING_ACTION_ROW_CONTROL_PX,
  LISTING_ACTION_ROW_HEIGHT_PX,
  LISTING_ACTION_ROW_PT_PX,
  LISTING_CARD_COVER_ASPECT_RATIO,
  LISTING_CARD_ICON_SIZE_PX,
  LISTING_CARD_TITLE_LINES,
  LISTING_CARD_TITLE_LINE_HEIGHT,
  LISTING_CARD_TITLE_MIN_HEIGHT,
} from '~/components/Apps/appListingCardGeometry';
import { listingGridColumnsAt } from '~/components/Apps/appListingGrid';
import { useIsomorphicLayoutEffect } from '~/hooks/useIsomorphicLayoutEffect';

/**
 * App Store Listings (W13) — the `/apps` store's LOADING state.
 *
 * 🔴 WHAT THIS BUYS, STATED NARROWLY. It removes the PER-CARD layout shift: the
 * store used to render `<Center py="xl"><Loader /></Center>` while the first page
 * loaded, so the grid appeared from nothing and every cell moved. A skeleton
 * occupying the card's exact box means each cell's top/left/width/height is
 * already final when the query resolves.
 *
 * 🔴 WHAT IT DOES **NOT** BUY, AND MUST NOT BE SOLD AS. Two shifts survive, both
 * by construction:
 *   · THE COUNT AXIS. This renders two rows at the current column count; the
 *     query returns up to 48. When the two differ the GRID still resizes on
 *     resolve — fewer/more rows — so page height moves even though no cell does.
 *   · THE RECENTS RAIL. It is seeded empty for SSR parity and hydrates from
 *     localStorage one frame late, inserting ~90px above the grid. That is the
 *     status quo (and is why the rail is rendered BELOW the search/sort controls
 *     — see `AppListingsMarketplaceBody`), and nothing here touches it.
 * "Zero layout shift" is therefore the wrong claim. "Zero per-card shift" is the
 * right one.
 *
 * 🔴 AND A THIRD, SMALLER ONE: the skeleton reserves the card's INVARIANT parts
 * only — cover, icon, the two RESERVED title lines, the creator line, the always-
 * rendered recommend rollup line, and the 46px action row. A card also renders a
 * conditional tagline (`line-clamp-3`), a Beta badge, and an owner-only
 * "Incomplete" badge, none of which the loading state can predict. A listing
 * carrying one is taller than its skeleton. See the parity test's fixture note.
 *
 * ── EVERY GEOMETRY NUMBER IS READ, NEVER SPELLED ────────────────────────────
 * 🔴 THIS FILE IMPORTS `appListingCardGeometry.ts` AND SO DOES `AppListingCard`.
 * That module exists for exactly this relationship: a skeleton that hand-copied
 * "16 / 9", 40, 2, 1.2, 10, 36 and 46 would drift from the card the first time
 * one of them moved, silently, with both files individually correct-looking.
 * `__tests__/appListingCardSkeleton.test.ts` enumerates the module's own
 * `Object.keys` and fails if this file stops reading any of them — the same guard
 * `appListingCardView.test.ts` already runs over the card.
 *
 * What is NOT single-sourced is the MARKUP the two files mirror (`gap={2}` on the
 * meta stack, `size="sm"`/`size="xs"` on the meta lines, `padding="md"` on the
 * Card). Those are not in the geometry module — the card spells them too — so the
 * thing that pins them is the MEASURED parity test
 * (`AppListingCardSkeleton.geometry.test.tsx`), which renders both grids and
 * compares boxes. Stated so nobody reads the import list above as covering more
 * than it does.
 */

/**
 * A skeleton bar shaped like ONE line of real text.
 *
 * 🔴 THE `<Text>` IS NOT DECORATION — IT IS THE MEASUREMENT. Its content is a
 * non-breaking space, so the element's line box is exactly the line box the real
 * card's `<Text>` of the same `size`/`fw` produces, whatever Mantine's font-size
 * and line-height tokens happen to be. The visible bar is an ABSOLUTELY
 * positioned `Skeleton` over it, i.e. out of flow, so it contributes no height of
 * its own and cannot change the answer. A bar with a hand-picked pixel height
 * would be a second copy of Mantine's type scale, and would go wrong the day the
 * theme moved.
 */
function MetaLineSkeleton({
  size,
  fw,
  widthPct,
  'data-testid': testId,
}: {
  size: 'sm' | 'xs';
  fw?: number;
  widthPct: number;
  'data-testid'?: string;
}) {
  return (
    <Text size={size} fw={fw} c="dimmed" style={{ position: 'relative' }} data-testid={testId}>
      {/* 🔴 A NON-BREAKING SPACE, NOT A PLAIN ONE. Whitespace-only text collapses under
          `white-space: normal`, which can leave the element with NO line box and therefore
          zero height — the reservation would then silently be nothing. `\u00A0` never
          collapses, and is written as an escape so it is visible in a diff. */}
      {'\u00A0'}
      <Skeleton
        style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `${widthPct}%` }}
      />
    </Text>
  );
}

/**
 * One store card's worth of reserved space.
 *
 * `aria-hidden` — it carries no information a screen reader wants; the grid it
 * sits in announces "Loading apps" once (see {@link AppListingCardSkeletonGrid}).
 */
export function AppListingCardSkeleton() {
  return (
    <Card
      padding="md"
      radius={0}
      className="h-full rounded-md"
      aria-hidden
      data-testid="apps-listing-card-skeleton"
    >
      {/* THE COVER. Same `Card.Section` + same ratio box as `ListingCover`, so the
          cover's height is derived from the column width before anything loads —
          in the skeleton for the same reason it is in the card. */}
      <Card.Section>
        <Box
          data-testid="apps-listing-skeleton-cover"
          style={{
            position: 'relative',
            width: '100%',
            aspectRatio: LISTING_CARD_COVER_ASPECT_RATIO,
            overflow: 'hidden',
          }}
        >
          <Skeleton radius={0} style={{ position: 'absolute', inset: 0 }} />
        </Box>
      </Card.Section>

      <Stack gap="sm" h="100%" pt="sm">
        <Group gap="xs" wrap="nowrap" align="flex-start" style={{ minWidth: 0 }}>
          {/* The publisher icon — a square of exactly the avatar's edge length. */}
          <Skeleton
            width={LISTING_CARD_ICON_SIZE_PX}
            height={LISTING_CARD_ICON_SIZE_PX}
            radius="md"
            style={{ flexShrink: 0 }}
            data-testid="apps-listing-skeleton-icon"
          />
          <Stack gap={2} style={{ minWidth: 0, flexGrow: 1 }}>
            {/* THE RESERVED TITLE BOX — the card's `min-height` reservation, in the
                same `em`, over the same font-size token.

                🔴 THE BARS ARE ABSOLUTE, AND THE BOX'S HEIGHT COMES FROM
                `LISTING_CARD_TITLE_MIN_HEIGHT` ALONE. That is what makes this box
                the same 2 lines tall as the card's title whether the real title
                wraps or not — the card reserves the full clamp height for every
                listing precisely so the rows below it land at the same y on every
                card. Laying the bars out in flow instead would make the height a
                function of the bars, i.e. of a number this file chose. */}
            <Box
              data-testid="apps-listing-skeleton-title"
              style={{
                position: 'relative',
                fontSize: 'var(--mantine-font-size-xl)',
                lineHeight: LISTING_CARD_TITLE_LINE_HEIGHT,
                minHeight: LISTING_CARD_TITLE_MIN_HEIGHT,
              }}
            >
              {Array.from({ length: LISTING_CARD_TITLE_LINES }, (_, i) => (
                <Skeleton
                  key={i}
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: `calc(${i} * ${LISTING_CARD_TITLE_LINE_HEIGHT}em)`,
                    height: `${LISTING_CARD_TITLE_LINE_HEIGHT}em`,
                    // Cosmetic only: a ragged last line reads as text rather than
                    // as a block. No geometry depends on it.
                    width: i === LISTING_CARD_TITLE_LINES - 1 ? '58%' : '100%',
                  }}
                />
              ))}
            </Box>
            {/* The creator chip's line. `size="sm"` / `fw={500}` mirror
                `CreatorChip`'s `TruncatedText`; the chip's 20px avatar is shorter
                than that line box, so the text is what sets the row height and the
                skeleton does not need to reproduce the avatar to match it. */}
            <MetaLineSkeleton
              size="sm"
              fw={500}
              widthPct={44}
              data-testid="apps-listing-skeleton-creator"
            />
            {/* The recommend rollup's line. It ALWAYS renders on a card — including
                for a listing with no reviews — which is what makes it safe to
                reserve unconditionally here. `size="xs"`, and the 13px thumb icon
                is again shorter than the line box. */}
            <MetaLineSkeleton size="xs" widthPct={62} data-testid="apps-listing-skeleton-rollup" />
          </Stack>
        </Group>

        {/* THE ACTION ROW — the card's own `mt="auto"` bottom pin, its padding and
            its minimum height, read from the same constants the card reads. The bar
            is the CTA: it grows into the row exactly as the button does
            (`flexGrow: 1` + `minWidth: 0`).

            🔴 `LISTING_ACTION_ROW_GAP_PX` IS THE ONE GEOMETRY CONSTANT THIS FILE
            DELIBERATELY DOES NOT READ, and that is a decision, not an omission. It
            is the gap BETWEEN the CTA and the `⋮` overflow trigger — and whether a
            card gets a trigger depends on the viewer being the owner or a
            moderator, which a loading state cannot know. So this row holds exactly
            one child and a gap has nothing to apply to. Passing it anyway would be
            an unread declaration that reads as load-bearing, which is the shape
            this component family has spent several rounds deleting (see the
            `@container` note in `AppListingCard.tsx`). It costs nothing in
            geometry: the trigger changes how wide the CTA is, never how tall the
            row or the card is — the parity test measures cards, and it is green for
            an owner and a signed-out viewer alike.
            `__tests__/appListingCardSkeleton.test.ts` names this exclusion
            explicitly, so it cannot become a silent hole. */}
        <Group
          mt="auto"
          pt={LISTING_ACTION_ROW_PT_PX}
          mih={LISTING_ACTION_ROW_HEIGHT_PX}
          wrap="nowrap"
          data-testid="apps-listing-skeleton-actions"
        >
          <Skeleton
            height={LISTING_ACTION_ROW_CONTROL_PX}
            style={{ flexGrow: 1, minWidth: 0 }}
            radius="sm"
          />
        </Group>
      </Stack>
    </Card>
  );
}

/**
 * How many ROWS of skeletons the store reserves while its first page loads.
 *
 * Two, deliberately: enough that the grid reads as a grid at every column count
 * (one row of five cards reads as a strip), and few enough that a small result
 * set does not shrink the page dramatically on resolve. It is NOT an estimate of
 * the result count — the query asks for 48 — so the count axis still moves. See
 * the header.
 */
export const APP_LISTING_SKELETON_ROWS = 2;

/**
 * The store's loading grid — the SAME markup and the SAME CSS module classes the
 * results grid uses, so a skeleton cell and a card cell get byte-identical track
 * geometry from the container query.
 *
 * 🔴 THE COLUMN COUNT IS MEASURED, NOT RESTATED. The ladder lives in
 * `appListingGrid.ts` (and, as CSS, in the stylesheet the unit test pins against
 * it); this reads the container's own width through the exported
 * `listingGridColumnsAt`, which is the single source. A second hardcoded ladder
 * here — or a set of `@container` rules hiding surplus cells — would be exactly
 * the drift `appListingGrid.ts` exists to prevent.
 *
 * 🔴 MEASURED IN A LAYOUT EFFECT, so the count is set BEFORE the browser paints
 * and the viewer never sees the zero-cell first render. `useIsomorphicLayoutEffect`
 * because this component renders during SSR too (the query has no server data, so
 * `isLoading` is true there) and `useLayoutEffect` warns on the server.
 */
export function AppListingCardSkeletonGrid() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(0);

  useIsomorphicLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setColumns(listingGridColumnsAt(el.getBoundingClientRect().width));
    measure();
    // Keep it right across a resize / a sub-nav reflow. Guarded because the
    // constructor is absent in some non-browser environments; the one-shot
    // `measure()` above still runs there.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className={gridClasses.gridContainer} ref={containerRef}>
      <div
        className={gridClasses.grid}
        data-testid="apps-listing-skeleton-grid"
        role="status"
        aria-busy="true"
        aria-label="Loading apps"
      >
        {Array.from({ length: columns * APP_LISTING_SKELETON_ROWS }, (_, i) => (
          <div key={i} data-testid="apps-listing-skeleton-col">
            <AppListingCardSkeleton />
          </div>
        ))}
      </div>
    </div>
  );
}
