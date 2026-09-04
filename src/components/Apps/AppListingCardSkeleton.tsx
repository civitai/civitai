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
import { listingGridColumnsAt, MANTINE_BREAKPOINT_PX } from '~/components/Apps/appListingGrid';
import { APPS_CONTAINER_GUTTER } from '~/components/Apps/appsPageWidths';
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
 * 🔴 AND A THIRD: CONTENT VARIANCE, WHICH RUNS IN **BOTH** DIRECTIONS. The skeleton
 * reserves cover, icon, the two RESERVED title lines, a creator line, the always-
 * rendered recommend rollup line, and the 46px action row. Four axes move a real
 * card off that:
 *   · a conditional tagline (`line-clamp-3`)      → card TALLER
 *   · an author-declared `Beta` badge             → card TALLER
 *   · an owner-only "Incomplete" badge            → card TALLER
 *   · NO CREATOR — `ListingCard.creator` is nullable and `CreatorChip` returns
 *     `null` for it — → card SHORTER, by the creator line plus the meta stack's gap.
 * ⚠️ THAT LAST ONE WAS MISSING FROM THIS LIST AND FROM THE PR BODY FOR A ROUND, both
 * of which said only "a listing carrying one is TALLER than its skeleton". It is not
 * hypothetical: measured at −22.29px (1376px grid / 4 columns) and −22.30px
 * (2450px / 5), and this PR's own `keepPreviousData` fixture uses `creator: null`.
 * It is pinned rather than merely described — see "a card with NO CREATOR is SHORTER"
 * in `AppListingCardSkeleton.geometry.test.tsx`, which derives the delta from the
 * rendered creator line rather than restating the number above.
 *
 * 🔴 SO "THE INVARIANT SHAPE" INCLUDES HAVING A CREATOR. The parity fixture is a
 * listing WITH a creator and WITHOUT a tagline or badges; that is the shape the
 * skeleton is exact for, and it is a choice (most listings have a creator, so
 * reserving the line is right more often than not), not a discovered invariant.
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
 * Card) — plus one deliberate DIVERGENCE: this file adds `flexGrow: 1` to the meta
 * `Stack`, which the card does not have. The card's stack is sized by its real text;
 * this one's content is absolutely-positioned bars over a non-breaking space, so
 * without it the stack shrink-to-fits to almost nothing and the bars (sized in `%`)
 * render as slivers. It changes no height — the title box is `min-height`-pinned and
 * both meta lines are single-line — which is why the parity test stays exact.
 * Those are not in the geometry module — the card spells them too — so the
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
 *
 * 🔴 `component="span"` ON THE SKELETON IS NOT COSMETIC — IT IS THE ONLY REASON THIS
 * IS VALID HTML. Mantine's `Text` renders a `<p>` and Mantine's `Skeleton` renders a
 * `<div>`, and `<div>` may not descend from `<p>`. An HTML parser auto-closes the
 * `<p>` at the `<div>`, so the parsed DOM is `<p></p><div></div>` while React's tree
 * is `<p><div/></p>` — a HYDRATION MISMATCH on every `/apps` load, EXACTLY 16 times:
 * 8 cells (`APP_LISTING_SKELETON_SSR_COLUMNS` x `APP_LISTING_SKELETON_ROWS`) x the two
 * meta lines each. An earlier draft said "16–20"; 20 would need 10 cells, which no
 * server render produces, and the mutation reproducing this observed `expected 16 to
 * be +0`.
 * It shipped in the first round of this PR and was invisible to the parity suite,
 * because the bar is `position: absolute` and therefore contributes no geometry for
 * a box comparison to see; the only signal was a `validateDOMNesting` warning on a
 * run that reported 7 passed. Both halves are now guarded —
 * `AppListingCardSkeleton.ssr.browser.test.tsx` scans the SERVER HTML for a `<div>`
 * inside a `<p>`, and the geometry suite fails the run on a `validateDOMNesting`
 * console error.
 *
 * 🔴 AND THE FIX IS ON THE SKELETON, NOT ON THE TEXT, DELIBERATELY. `<Text
 * component="div">` would also be valid HTML, and it would change the element this
 * line is measured on. The whole point of the `<Text>` is that its line box equals
 * the line box `AppListingCard`'s own `<Text size="xs">` (a `<p>`) produces, so
 * moving the tag moves the measurement — the thing this component exists to
 * reproduce. `position: absolute` blockifies the span, so nothing about the bar
 * changes either.
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
        component="span"
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
            geometry, MEASURED not assumed: `AppListingCardSkeleton.geometry.test.tsx`
            renders the same listings for a signed-out viewer and for their owner and
            pins that the CTA gives up exactly the trigger + the row gap of WIDTH
            while the card's box is identical across the two arms.
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
 * 🔴 THE COLUMN COUNT USED BEFORE ANYTHING HAS BEEN MEASURED — i.e. on the SERVER,
 * and on the client's first render before the layout effect runs.
 *
 * ⚠️ THIS CONSTANT EXISTS BECAUSE ITS ABSENCE SHIPPED A REGRESSION, AND THE COMMENT
 * THAT USED TO SIT BELOW ASSERTED THE OPPOSITE OF WHAT THE CODE DID. It read "the
 * count is set BEFORE the browser paints and the viewer never sees the zero-cell
 * first render", one sentence after correctly noting that this component renders
 * during SSR. `useIsomorphicLayoutEffect` is `useLayoutEffect` only when `window`
 * exists and a plain `useEffect` otherwise, so **it does not run during SSR at
 * all** — and with the seed at 0 the server emitted an EMPTY `.grid`. tRPC runs
 * `ssr: false`, so the server always renders the `isLoading` branch: this component
 * replaced a spinner with literally nothing on first paint, then popped two rows of
 * skeletons in at hydration. Found by an adversarial audit, not by a test; the
 * `renderToString` guard in `AppListingCardSkeleton.ssr.browser.test.tsx` is the
 * test that did not exist.
 *
 * 🔴 WHY A SEED IS SAFE AT ALL — AND IT IS THE WHOLE JUSTIFICATION, SO CHECK IT
 * BEFORE CHANGING THE VALUE. This number decides HOW MANY cells are rendered. It
 * does NOT decide how WIDE they are: the columns come from the `@container` ladder
 * in `AppListingsMarketplaceBody.module.scss`, which is CSS and is correct on the
 * very first paint at every viewport. So a wrong seed can only ever move the COUNT
 * axis — the shift this component's header already declares as unresolved — and can
 * never produce a wrongly-sized cell.
 *
 * That is what makes 4 the right default rather than 1. It is DERIVED, not chosen:
 * `listingGridColumnsAt` at the `xl` breakpoint's grid width, i.e. the widest rung
 * the legacy Mantine half of the ladder reaches, which is what a desktop first paint
 * lands on. The two ways it is wrong, both count-only:
 *   · a PHONE (1 column) paints 8 stacked cells and settles to 2. The grid is the
 *     last element on the page, so shrinking it moves nothing above it, and the
 *     surplus is below the fold;
 *   · a 2364px+ grid (5 columns) paints 8 and settles to 10 — it under-reserves by
 *     two cells rather than by the whole grid.
 * Seeding 1 instead would be correct on a phone and would make every desktop first
 * paint render two full-width cards that then become eight quarter-width ones —
 * a PER-CELL shift, which is the thing this PR exists to remove.
 */
export const APP_LISTING_SKELETON_SSR_COLUMNS = listingGridColumnsAt(
  MANTINE_BREAKPOINT_PX.xl - APPS_CONTAINER_GUTTER
);

/**
 * The inline size an `@container` query would see for `el` — i.e. its CONTENT box.
 *
 * 🔴 CONTENT BOX, NOT BORDER BOX. The ladder that actually lays this grid out is an
 * `@container (min-width: …)` query, and a query container's size is its content box.
 * `getBoundingClientRect()` returns the BORDER box. Today `.gridContainer` declares
 * neither padding nor a border, so the two numbers are identical and either would
 * work — which is precisely the hazard: a later `padding: 8px` on that class would
 * silently desynchronise the cell COUNT computed here from the track count CSS
 * renders. Subtracting makes the two definitions agree by construction rather than by
 * coincidence.
 *
 * `getBoundingClientRect()` rather than `clientWidth`: the latter is rounded to an
 * integer, so a container at 1167.6px would report 1168 and pick the four-column rung
 * while the (fractional) container query stays on three.
 *
 * 🔴 EXPORTED SO IT CAN BE GUARDED DIRECTLY, AND THAT EXPORT IS THE POINT. The first
 * attempt guarded this relationship end-to-end — "the cell count is two rows of the
 * grid CSS actually laid out" — and an audit measured that guard PASSING with and
 * without the desync it was written for. The reason is structural rather than a
 * mistake in the assertion: the parity fixtures sit deliberately MID-BAND (1376 is
 * 208px above the 1168 rung, 2450 is 86px above 2364) so that they cannot be tripped
 * by an off-by-one, and that same margin means no plausible padding can move the
 * column count. The property that makes them good parity fixtures is what blinded the
 * desync guard. Two guards wanted opposite fixtures and were sharing one list.
 *
 * So the desync is now guarded HERE, against the element's own content box, with no
 * fixture involved at all — see "the query inline size IS the container's content
 * box" in `AppListingCardSkeleton.geometry.test.tsx`. The end-to-end count↔row test
 * is kept, with its claim narrowed to what it actually checks.
 */
export function gridQueryInlineSize(el: HTMLElement): number {
  const rect = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const px = (v: string) => parseFloat(v) || 0;
  return (
    rect.width -
    px(cs.paddingLeft) -
    px(cs.paddingRight) -
    px(cs.borderLeftWidth) -
    px(cs.borderRightWidth)
  );
}

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
 * The seed above covers the server and the pre-effect render; the effect below
 * corrects it on the client, before paint.
 */
export function AppListingCardSkeletonGrid() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(APP_LISTING_SKELETON_SSR_COLUMNS);

  useIsomorphicLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setColumns(listingGridColumnsAt(gridQueryInlineSize(el)));
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
    <div
      className={gridClasses.gridContainer}
      ref={containerRef}
      data-testid="apps-listing-skeleton-grid-container"
      role="status"
    >
      {/* 🔴 NO `aria-busy` HERE, AND THAT IS A CORRECTION, NOT AN OMISSION.
          This region carried `role="status" aria-busy="true"` with `aria-label="Loading
          apps"` and EVERY descendant `aria-hidden`. `aria-busy="true"` on a live region
          is the standard instruction to WITHHOLD announcements until it clears, and it
          was a hardcoded literal that never flipped to false (the grid unmounts
          instead); a region whose whole subtree is `aria-hidden` has no content to
          announce either way; and a live region announces its CONTENT, not its label.
          So the loading state most likely announced nothing — in markup whose own
          comment claimed it was the one thing on the page that did.
          The fix is real text in the live region and no busy flag.

          ⚠️ NOT VERIFIED WITH A SCREEN READER, by me or by the audit that found it.
          What is claimed is only that the markup can now announce — a live region, not
          marked busy, with non-hidden text content — not that a particular AT does. */}
      {/* 🔴 THE LIVE REGION IS THE CONTAINER, NOT THE GRID, so this text can sit
          INSIDE it without becoming a grid item. On `.grid` it would be a cell —
          an extra track's worth of layout, in the component whose entire job is
          reserving exact boxes. (Tailwind's `sr-only` is `position: absolute`, so
          it would in fact be out of flow either way; relying on that would be a
          load-bearing detail of a utility class nobody would think to check.) */}
      <span className="sr-only">Loading apps</span>
      <div className={gridClasses.grid} data-testid="apps-listing-skeleton-grid">
        {Array.from({ length: columns * APP_LISTING_SKELETON_ROWS }, (_, i) => (
          <div key={i} data-testid="apps-listing-skeleton-col">
            <AppListingCardSkeleton />
          </div>
        ))}
      </div>
    </div>
  );
}
