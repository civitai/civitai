import { Box, Card, Divider, Group, Skeleton, Stack, Text } from '@mantine/core';
import { useRef, useState } from 'react';
import gridClasses from '~/components/Apps/AppListingsMarketplaceBody.module.scss';
import {
  LISTING_CARD_COVER_ASPECT_RATIO,
  LISTING_CARD_CREATOR_AVATAR_PX,
  LISTING_CARD_CTA_HEIGHT_PX,
  LISTING_CARD_FOOTER_HEIGHT_PX,
  LISTING_CARD_HEADER_CENTER_PX,
  LISTING_CARD_ICON_OVERLAP_PX,
  LISTING_CARD_ICON_SIZE_PX,
  LISTING_CARD_TITLE_LINE_HEIGHT,
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
 * 🔴 AND A THIRD: CONTENT VARIANCE — WHICH NOW RUNS IN ONE DIRECTION ONLY. The
 * skeleton reserves cover, icon, the two RESERVED title lines, the 46px action row,
 * and the always-rendered stats line BELOW that row. Three axes move a real card off
 * that, all of them UPWARD:
 *   · a conditional tagline (`line-clamp-3`)      → card TALLER
 *   · an author-declared `Beta` badge             → card TALLER
 *   · an owner-only "Incomplete" badge            → card TALLER
 *
 * 🔴 THE FOURTH AXIS — THE ONLY DOWNWARD ONE — IS GONE, AND THAT IS A REAL
 * IMPROVEMENT RATHER THAN A LINE DELETED FROM A LIST. It read: "NO CREATOR —
 * `ListingCard.creator` is nullable and `CreatorChip` returns `null` for it —
 * → card SHORTER, by the creator line plus the meta stack's gap" (measured at
 * −22.29px on a 1376px grid, −22.30px at 2450px). The store card no longer renders
 * an author chip at all (2026-09-06, operator's call), so this skeleton reserves no
 * creator line and a `creator: null` listing — which this suite's own
 * `keepPreviousData` fixture is — is now EXACTLY its skeleton's height. The geometry
 * suite pins that as an equality where it used to pin the delta.
 *
 * 🔴 SO "THE INVARIANT SHAPE" NO LONGER DEPENDS ON THE CREATOR FIELD. The parity
 * fixture is a listing WITHOUT a tagline and WITHOUT badges; whether it carries a
 * creator is now irrelevant to its height, which is one fewer choice the reservation
 * has to be right about.
 *
 * 🔴 THE STATS LINE IS RESERVED UNCONDITIONALLY, AND THE PLAY COUNT COSTS NOTHING
 * EXTRA. The card renders the recommend rollup and — when `openCount` is not `null`
 * — the play count on ONE flex line (`wrap="nowrap"`), so an off-site listing that
 * omits the play count is the same HEIGHT as an on-site one that shows it. That is
 * what lets this file reserve the line without knowing the listing's kind, which a
 * loading state structurally cannot.
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
 * What is NOT single-sourced is the MARKUP the two files mirror (`gap="sm"` on the
 * outer stack, `gap={2}` on the meta stack, `size="xs"` on the stats line,
 * `padding="md"` on the Card) — plus one deliberate DIVERGENCE: this file adds
 * `flexGrow: 1` to the meta `Stack`, which the card does not have. The card's stack
 * is sized by its real text; this one's content is absolutely-positioned bars over a
 * non-breaking space, so without it the stack shrink-to-fits to almost nothing and
 * the bars (sized in `%`) render as slivers. It changes no height — the title box is
 * `min-height`-pinned and the stats line is single-line — which is why the parity
 * test stays exact. (This sentence used to say "both meta lines are single-line".
 * There is one line now and it is not in the meta block: the creator line is gone
 * and the rollup line moved below the action row.)
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
 * card's `<Text>` of the same `size` produces, whatever Mantine's font-size and
 * line-height tokens happen to be. The visible bar is an ABSOLUTELY
 * positioned `Skeleton` over it, i.e. out of flow, so it contributes no height of
 * its own and cannot change the answer. A bar with a hand-picked pixel height
 * would be a second copy of Mantine's type scale, and would go wrong the day the
 * theme moved.
 *
 * 🔴 `component="span"` ON THE SKELETON IS NOT COSMETIC — IT IS THE ONLY REASON THIS
 * IS VALID HTML. Mantine's `Text` renders a `<p>` and Mantine's `Skeleton` renders a
 * `<div>`, and `<div>` may not descend from `<p>`. An HTML parser auto-closes the
 * `<p>` at the `<div>`, so the parsed DOM is `<p></p><div></div>` while React's tree
 * is `<p><div/></p>` — a HYDRATION MISMATCH on every `/apps` load, once per rendered
 * `MetaLineSkeleton`.
 *
 * ⚠️ THE COUNT IN THIS PARAGRAPH IS RE-DERIVED, NOT RE-MEASURED, AND IS FLAGGED
 * RATHER THAN QUIETLY EDITED. It read "EXACTLY 16 times: 8 cells
 * (`APP_LISTING_SKELETON_SSR_COLUMNS` x `APP_LISTING_SKELETON_ROWS`) x the two meta
 * lines each", against a measurement of `expected 16 to be +0`. There is ONE
 * `MetaLineSkeleton` per cell now (the creator line was deleted with the card's
 * author chip and the rollup line moved below the action row), so the same
 * arithmetic gives 8 x 1 = 8. Nobody has re-run the mutation to observe an
 * `expected 8 to be +0` — the browser tiers do not run on the machine this change
 * was made on — so treat 8 as arithmetic and 16 as the historical measurement.
 * What is NOT derived and does not need re-measuring is the guard itself: the
 * assertion is `toBe(0)`, which is independent of how many instances there are.
 *
 * It shipped in the first round of that PR and was invisible to the parity suite,
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
// 🔴 `fw` IS GONE FROM THIS SIGNATURE, NOT LEFT UNUSED. It existed for the `sm`
// creator line (`fw={500}`, mirroring the retired `CreatorChip`'s `TruncatedText`);
// the one surviving caller passes no weight. An optional prop nothing supplies is
// the same shape as the unread `@container` declaration this component family
// already deleted — it reads as load-bearing to the next person. `size` is kept
// general because it IS supplied.
function MetaLineSkeleton({
  size,
  widthPct,
  'data-testid': testId,
}: {
  size: 'sm' | 'xs';
  widthPct: number;
  'data-testid'?: string;
}) {
  return (
    <Text size={size} c="dimmed" style={{ position: 'relative' }} data-testid={testId}>
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
 * `aria-hidden` — it carries no information a screen reader wants. The announceable
 * text lives in the live region on the grid's CONTAINER (see
 * {@link AppListingCardSkeletonGrid}), not on the grid: this comment used to name the
 * grid, and the commit that moved `role="status"` onto the container left the sentence
 * describing a tree it had just changed. Whether any assistive tech actually announces
 * it is untested — see the hedge at the render site.
 */
export function AppListingCardSkeleton() {
  return (
    <Card
      padding={0}
      radius={0}
      className="h-full rounded-md"
      aria-hidden
      data-testid="apps-listing-card-skeleton"
    >
      {/* THE COVER. Same `Card.Section` + same ratio box as `ListingCover`, so the
          cover's height is derived from the column width before anything loads. */}
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
      <Stack gap="xs" h="100%" px="md" pb="sm">
        {/* THE HEADER ROW — icon (pulled up over the cover), title, Open. Every number is
            the card's own constant; the title and the CTA are centred on the ICON's centre
            exactly as in the card. */}
        <Group gap="sm" wrap="nowrap" align="flex-start" style={{ minWidth: 0 }}>
          <Skeleton
            width={LISTING_CARD_ICON_SIZE_PX}
            height={LISTING_CARD_ICON_SIZE_PX}
            radius="md"
            style={{ flexShrink: 0, marginTop: -LISTING_CARD_ICON_OVERLAP_PX }}
            data-testid="apps-listing-skeleton-icon"
          />
          {/* One title line: its height is the line-height times the title's font size, as in
              the card (the title is one ellipsized line). */}
          <Box
            data-testid="apps-listing-skeleton-title"
            style={{
              position: 'relative',
              flex: 1,
              minWidth: 0,
              fontSize: 'var(--mantine-font-size-xl)',
              lineHeight: LISTING_CARD_TITLE_LINE_HEIGHT,
              height: `${LISTING_CARD_TITLE_LINE_HEIGHT}em`,
              marginTop: `calc(${LISTING_CARD_HEADER_CENTER_PX}px - ${
                LISTING_CARD_TITLE_LINE_HEIGHT / 2
              }em)`,
            }}
          >
            <Skeleton style={{ position: 'absolute', inset: 0, width: '70%' }} />
          </Box>
          <Skeleton
            width={72}
            height={LISTING_CARD_CTA_HEIGHT_PX}
            radius="sm"
            style={{
              flexShrink: 0,
              marginTop: `calc(${LISTING_CARD_HEADER_CENTER_PX}px - ${
                LISTING_CARD_CTA_HEIGHT_PX / 2
              }px)`,
            }}
            data-testid="apps-listing-skeleton-actions"
          />
        </Group>
        {/* THE FOOTER — bottom-pinned like the card's: a divider, then the reviews/plays line
            on the left and the creator on the right, at the card's footer height. It is
            reserved unconditionally (the rollup half always renders on a card, and the play
            count shares its line). */}
        <Divider mt="auto" />
        <Group
          gap="sm"
          wrap="nowrap"
          justify="space-between"
          mih={LISTING_CARD_FOOTER_HEIGHT_PX}
          data-testid="apps-listing-skeleton-footer"
        >
          <MetaLineSkeleton size="xs" widthPct={100} data-testid="apps-listing-skeleton-rollup" />
          <Skeleton
            width={72}
            height={LISTING_CARD_CREATOR_AVATAR_PX}
            radius="xl"
            style={{ flexShrink: 0 }}
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
 * That is what makes the derived rung the right default rather than 1. It is DERIVED,
 * not chosen: `listingGridColumnsAt` at the `xl` breakpoint's grid width, i.e. the
 * widest rung the legacy Mantine half of the ladder reaches, which is what a desktop
 * first paint lands on.
 *
 * ⚠️ THE VALUE IS 3 SINCE THE RAIL RE-TUNE, NOT 4 — the expression is unchanged and the
 * ladder moved under it (`lg`/`xl` mean three columns now, four starts at 2242 of grid).
 * That is the derivation working as intended; it is flagged here only because the
 * paragraphs below used to quote 4 and 8, and a stale worked example reads as a
 * specification.
 *
 * The two ways it is wrong, both count-only:
 *   · a PHONE (1 column) paints 6 stacked cells and settles to 2. The grid is the
 *     last element on the page, so shrinking it moves nothing above it, and the
 *     surplus is below the fold;
 *   · a 2242px+ grid (4 columns) paints 6 and settles to 8 — it under-reserves by
 *     two cells rather than by the whole grid.
 * Seeding 1 instead would be correct on a phone and would make every desktop first
 * paint render two full-width cards that then become six third-width ones —
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
 * integer, so a container at 959.6px would report 960 and pick the three-column rung
 * while the (fractional) container query stays on two.
 *
 * 🔴 EXPORTED SO IT CAN BE GUARDED DIRECTLY, AND THAT EXPORT IS THE POINT. The first
 * attempt guarded this relationship end-to-end — "the cell count is two rows of the
 * grid CSS actually laid out" — and an audit measured that guard PASSING with and
 * without the desync it was written for. The reason is structural rather than a
 * mistake in the assertion: the parity fixtures sit deliberately MID-BAND (1376 is
 * 416px above the 960 rung, 2450 is 208px above 2242) so that they cannot be tripped
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
