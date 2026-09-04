import type { ReactNode } from 'react';
import {
  APPS_CARD_LIST_GAP,
  APPS_CARD_LIST_MIN_COLUMN,
  APPS_CONTAINER_GUTTER,
  APPS_LEGACY_CONTAINER_WIDTH,
  APPS_PAGE_CONTAINER_WIDTH,
} from '~/components/Apps/appsPageWidths';

/**
 * HOW A `/apps/*` SURFACE SPENDS SURPLUS CONTAINER WIDTH.
 *
 * `~/components/Apps/appsPageWidths` decides how wide a route's body is allowed to be.
 * This module decides what the body DOES with it, and it exists because the two are
 * different questions that were answered as one: the ultrawide pass raised the shared
 * container 1920 → 2560, and the routes that take no measure went from 1888 to 2528 of
 * content without a single column getting wider.
 *
 * 🔴 THE DEFECT IS A GAP, NOT A CLIP. Nothing was cut off — a table's columns simply
 * stayed at their content width and the table distributed the extra 640px as PADDING,
 * which on a `space-between` row lands entirely between a row's content and the control
 * that acts on it. Measured on `/apps/installed`, where THREE
 * `Group justify="space-between" wrap="nowrap"` rows (in `PinnedInstallRow`,
 * `InstalledAppCard` and `HiddenBlocksPanel`) each moved their button 640px further from
 * the name it belongs to. `/apps/review` had the same shape and had been "fixed" by
 * CAPPING THE PAGE at 1368 — a workaround this module replaces, so that cap is deleted.
 *
 * TWO MECHANISMS, one per surface shape:
 *
 *   · A TABLE takes {@link AppsTableColgroup}. Every column except the PRIMARY one gets
 *     a percentage width; the primary gets none, so CSS's automatic table layout hands
 *     it everything left over. That is why there is exactly one `null` in each ledger
 *     below — and WHICH column gets it is a decision, not a default; see the two cases.
 *   · A CARD LIST takes {@link AppsCardGrid}. Cards go SIDE BY SIDE once the container
 *     is wide enough for two of {@link APPS_CARD_LIST_MIN_COLUMN}, so the surplus buys
 *     a column instead of stretching one card across the screen.
 *
 * 🔴 NEITHER MECHANISM MAY BE REPLACED BY A BODY CAP. Refusing the width is what the
 * container pass exists to stop doing, and a cap is invisible to every guard here —
 * see `__tests__/appsPageWidths.test.ts` for the taxonomy pins that keep these routes
 * in `APPS_FULL_MEASURE_PAGES`.
 *
 * 🔴 WHICH COLUMN IS PRIMARY IS A DECISION WITH TWO CASES, AND GETTING IT WRONG MAKES THE
 * DEFECT WORSE RATHER THAN BETTER. The slack has to land somewhere; "the primary column
 * absorbs it" only helps when that column can USE it.
 *
 *   (a) A column with genuinely VARIABLE, long content — an app name, a free-text reason,
 *       an event detail — is primary. The slack becomes headroom for real content that
 *       would otherwise truncate.
 *   (b) A table where NO column has that — every cell a slug, a badge, a date, or a
 *       hard-CAPPED text — takes its LAST column as primary instead, so the slack TRAILS
 *       the row rather than splitting it. That column is usually the action column, and
 *       the reason it works is that a cell's content is left-aligned: the control sits at
 *       its LEFT edge, so the slack lands to the RIGHT of the button. ⚠️ THAT ONLY HOLDS
 *       IF THE CELL REALLY IS LEFT-ALIGNED — `OffsiteReportsQueue`'s action `Group` was
 *       `justify="flex-end"`, which pins the buttons to the table's right edge and turns
 *       case (b) into the defect. It is `flex-start` now; that is a no-op at every width
 *       where the column sits at min-content, i.e. everywhere it is not the primary.
 *
 * 🔴 "VARIABLE" MEANS THE CELL CAN ACTUALLY USE THE PIXELS — measure it, do not read the
 * field name. Two ledgers were wrong on exactly this and both were caught by rendering:
 *   · `OffsiteReportsQueue`'s `Reason` looked like free text and is
 *     `lineClamp={2} style={{ maxWidth: 260 }}`. Measured 1440 → 2560 with it primary:
 *     the column went 587.73 → 1404.64 (+816.91) while the details box stayed **260 at
 *     both** — ~1145px of dead space inside the cell, i.e. padding relabelled.
 *   · `AppActivityPanel`'s `Detail` looked like the payload and is a fixed monospace ref.
 *     With it primary the column went 971.56 → 1744.34 (+772.78) while its glyph box
 *     stayed **151.72 at both**. The component's own comment said so; the ledger did not.
 *
 * `ActivePreviewsPanel` is why this is written down. Its first ledger made `App` primary
 * on the general rule — and `App` is a short `<Code>{slug}</Code>`, so 49% of the table
 * became dead space sitting *between* the slug and the "Tear down" button. Modelled
 * against the measured no-ledger baseline that is a WIDER gap than doing nothing at all.
 * Case (b) puts the same slack past the button, where nothing has to be scanned across it.
 *
 * 🔴 AND THE FIXED SHARES ARE SIZED TO CONTENT, NOT SPREAD TO FILL. A non-primary
 * percentage that exceeds what its cell needs at the wide width is padding again, just
 * relabelled — it re-creates a slice of the defect between every pair of columns. Each
 * number below is roughly the cell's own width at the CURRENT container, which is small;
 * at narrow widths min-content wins anyway (see the next paragraph), so the visible effect
 * on a 1440 monitor is nil.
 *
 * ⚠️ A PERCENTAGE IS A PREFERENCE, NOT A FLOOR-AND-CEILING. Under automatic table layout
 * a column is never squeezed below its MIN-CONTENT width, so on a narrow viewport a
 * column whose percentage is smaller than its content simply takes what it needs and the
 * primary gives way. That is the correct behaviour — these ledgers exist to place the
 * SURPLUS on a wide screen, not to compress anything on a narrow one — but it does mean
 * the percentages are only observably in force once the table is wider than the sum of
 * its columns' min-content widths.
 *
 * 🔴 NO WIDTH-CONDITIONAL COLUMN SET. A ledger is a list of WIDTHS for a fixed set of
 * columns; a column that exists only on wide screens would be a discoverability and an
 * a11y problem (screen readers and narrow viewports would see a different table) and it
 * would double the test surface. Where a table legitimately has two SHAPES — the review
 * queue's Deploy column, the revenue table's App column — both shapes are enumerated
 * here as their own ledger and the choice is made by DATA, never by width.
 */

/**
 * One table's column widths, in document order.
 *
 * A `number` is a percentage of the table's width. `null` marks the PRIMARY column,
 * which is deliberately given no width at all so it absorbs whatever the percentages
 * leave — the whole point of the ledger.
 */
export type AppsTableColumns = readonly (number | null)[];

/**
 * Everything wrong with a ledger, as messages. Empty means valid.
 *
 * 🔴 A FUNCTION RATHER THAN AN INLINE ASSERTION, so the RULE has a test of its own on
 * inputs that must be rejected. A validator whose only inputs are the four real ledgers
 * — all of which pass — is a validator nobody has watched work.
 */
export function appsTableColumnProblems(label: string, columns: AppsTableColumns): string[] {
  const problems: string[] = [];
  if (columns.length === 0) {
    return [`${label}: an empty ledger describes no table`];
  }
  const primaries = columns.filter((c) => c === null).length;
  if (primaries !== 1) {
    problems.push(
      `${label}: exactly ONE column must be the primary (null) so it can absorb the ` +
        `slack — found ${primaries}`
    );
  }
  for (const [i, c] of columns.entries()) {
    if (c === null) continue;
    if (!Number.isFinite(c) || c <= 0) {
      problems.push(`${label}: column ${i} must be a positive percentage, got ${c}`);
    }
  }
  const total = columns.reduce<number>((sum, c) => sum + (c ?? 0), 0);
  // Strictly less than 100: at exactly 100 the primary column would be handed nothing,
  // which is a ledger that has stopped doing the one thing it exists for.
  if (total >= 100) {
    problems.push(
      `${label}: the non-primary columns claim ${total}% — they must leave the primary ` +
        `column a share of its own (< 100%)`
    );
  }
  return problems;
}

/**
 * The `/apps/review` QUEUE table (`UnifiedReviewList`) — Kind · **App** · Submitter ·
 * date · [Deploy] · action.
 *
 * The App column is primary: it is the only cell carrying a variable-length identity
 * (a slug plus an optional title), and it is what a moderator scans down. Everything
 * else is a badge, a username, a formatted date or a button — all of which have a
 * natural width that more space does not improve.
 *
 * The Deploy column exists on the Approved tab only, so BOTH shapes are enumerated
 * rather than one being patched at the call site. Its presence is decided by whether a
 * retrigger handler was supplied — i.e. by data, never by width.
 */
export const APPS_REVIEW_QUEUE_COLUMNS = {
  /** Pending / Rejected: Kind · App · Submitter · date · action. */
  withoutDeploy: [6, null, 6, 9, 6] as AppsTableColumns,
  /** Approved: Kind · App · Submitter · date · Deploy · action. */
  withDeploy: [5, null, 5, 8, 8, 5] as AppsTableColumns,
} as const;

/**
 * The `/apps/mine` table (`MyAppsBody`) — **App** · Cover · Status · Updated.
 *
 * App is primary for the same reason as above, and here it also carries the icon and
 * the slug, so it is the cell that most wants the room. Cover is a fixed 96px image, so
 * its 12% is a floor rather than an aspiration; Status holds up to three badges plus
 * the completeness advisory, which is why it is the widest fixed share.
 */
export const APPS_MINE_COLUMNS: AppsTableColumns = [null, 5, 10, 5];

/**
 * The `/apps/review` MANAGE-LISTINGS table (`AppListingsModerationTable`) —
 * **App** · Owner · Category · Reviews · actions.
 *
 * The action cell is a `Group` of buttons plus a menu, so it gets the second-largest
 * share; it still cannot be primary, because its natural width is set by its buttons
 * and handing it the slack would push the buttons away from the row again.
 */
export const APPS_MOD_LISTINGS_COLUMNS: AppsTableColumns = [null, 5, 5, 4, 13];

/**
 * The revenue attributions table (`RevenuePanel`) — Date · [App] · **Scope** · Buzz ·
 * Gross · Your share · Status.
 *
 * TWO SHAPES, and the primary column MOVES between them, which is why they are two
 * ledgers rather than one with a hole:
 *   · unscoped (`/apps/revenue`) — App is a link to a per-app page and is primary;
 *   · scoped (`/apps/<id>/revenue`) — there IS no App column, because every row is the
 *     same app, so Scope takes the slack.
 * Both are numbers-only decisions about a fixed column set; nothing here is width-aware.
 */
export const APPS_REVENUE_COLUMNS = {
  /** `/apps/revenue`: Date · App · Scope · Buzz · Gross · Your share · Status. */
  withApp: [5, null, 7, 5, 5, 6, 7] as AppsTableColumns,
  /** `/apps/<appBlockId>/revenue`: Date · Scope · Buzz · Gross · Your share · Status. */
  scoped: [6, null, 6, 6, 7, 8] as AppsTableColumns,
} as const;

/**
 * The `/apps/review` ACTIVE-PREVIEWS panel (`ActivePreviewsPanel`) —
 * **App** · Version · State · Age · actions.
 *
 * 🔴 THIS LEDGER IS THE ONE THAT PROVES THE POINT OF ENUMERATING THEM. `/apps/review`
 * renders FOUR tables, and the first pass gave ledgers to two of them while removing the
 * 1368 cap that had been holding the other two down. Measured on the real panel in the
 * real layout, 1440 → 2560, with no ledger:
 *
 *   columns  228.02 | 165.17 | 146.45 | 152.05 | 682.31   (1440)
 *            413.89 | 299.83 | 265.84 | 276.00 | 1238.44  (2560)
 *   slug → "Tear down" gap   817.36 → 1381.23   (+563.87)
 *
 * ⚠️ THAT PAIR WAS FIRST RECORDED AS `609.67 → 1173.55`, WHICH IS A DIFFERENT QUANTITY.
 * The two differ by which endpoint the gap is measured to: 609.67/1173.55 is the `<Code>`
 * BORDER BOX to the row's FIRST control (the "Open full-page preview" anchor); the shipped
 * helper measures the slug's GLYPH RANGE to the "Tear down" BUTTON. The DELTA is +563.87
 * either way, so nothing about the argument moved — but a live assertion message that
 * quoted one pair while printing the other reads as a broken harness, so the numbers here
 * are the ones the guard actually produces.
 *
 * i.e. half the container's 1120px delta landed between a row's identity and the control
 * acting on it — the exact phenomenon the header of this file calls THE DEFECT, on the
 * route whose cap this change removes. Uncapping a page is a claim about EVERY table on
 * it, which is why `__tests__/appsWideLayout.test.ts` now enumerates them instead of
 * naming the ones somebody remembered.
 *
 * 🔴 THE PRIMARY IS THE **ACTION** COLUMN — case (b) at the top of this file, and this
 * table is the worked example. Every data cell here is short and fixed in kind: a slug, a
 * version, a state badge, a relative age. Making `App` primary on the general rule put the
 * slack *inside* the column the reader has to scan across to reach the button, which is
 * the defect with extra steps. With the action column primary, the surplus lands past the
 * buttons.
 *
 * 🔴 AND THE FOUR SHARES ARE DELIBERATELY TOO SMALL TO BIND — this is the shrink-to-content
 * idiom, not a proportion. A percentage is a preference floored at min-content, so a share
 * smaller than the cell needs resolves to the cell's own width at EVERY container width,
 * which is what makes those four columns CONSTANT. It has to be spelled this way here:
 * ordinary content-sized shares (9/7/6/6) still grow with the table, and measured on this
 * fixture that alone moved the slug → "Tear down" gap 510.38 → 823.95. The same numbers
 * with these shares hold it flat.
 */
export const APPS_ACTIVE_PREVIEWS_COLUMNS: AppsTableColumns = [3, 2, 2, 2, null];

/**
 * The `/apps/review` REPORTS tab (`OffsiteReportsQueue`) —
 * **App** · Reason · Reporter · Reported · Status · actions.
 *
 * 🔴 THE ACTIONS COLUMN IS PRIMARY — case (b), and this ledger got it wrong twice before
 * measurement settled it.
 *
 * The first version made `App` primary on "it names the row". The second made `Reason`
 * primary on "it is operator-written free text, and giving the slack to the slug would
 * widen an identifier while the sentence stayed wrapped". BOTH sentences are about what
 * the fields MEAN; neither is about what the cells can DO, and the second is simply false:
 * the details `Text` is `lineClamp={2} style={{ maxWidth: 260 }}`, so it renders 260px
 * wide at 1440 and 260px wide at 2560. Measured with `Reason` primary, 1440 → 2560:
 *
 *   columns   140.59 | 587.73  | 90.36  | 98.41  | 74.8  | 414.11
 *             252.59 | 1404.64 | 151.55 | 176.81 | 126.3 | 414.11
 *   details box  260 → 260
 *
 * — the primary column took +816.91 and the sentence gained nothing.
 *
 * `App` is the near miss worth recording, because it is NOT a slug-only cell: it carries
 * an uncapped listing NAME under the slug, and that name genuinely grows (glyph box
 * 98.05 → 199.45 across the same pair). It is a real case-(a) candidate — and still the
 * wrong one, because ~200px of name cannot absorb ~1350px of surplus either. When NO cell
 * can, case (b) is the answer and the question stops being "which column deserves it".
 *
 * 🔴 `Reason` KEEPS A LARGE FIXED SHARE (21%) EVEN THOUGH IT IS NOT PRIMARY, and the
 * number is set by the NARROW end, not the wide one. Its cell needs `260 + 32` of padding
 * to render the capped text at all, and 12% — the share its content wants at 2528 — is only
 * 169px at 1408, which measured a details box of **136.72** instead of 260. That is losing
 * visible text on a 1440 monitor to tidy up a 2560 one, i.e. exactly what this module's
 * provenance rule forbids. 21% of 1408 is 296, so the cap binds at both ends (260 → 260).
 * The residue is ~239px of dead space inside `Reason` at 2528 — the honest cost of a
 * hard-capped cell in a fluid table, and smaller than any alternative measured.
 * `Reporter`, `Reported` and `Status` are shrink-to-content (3/4/3) so they stay at their
 * own widths and the controls do not recede.
 */
export const APPS_OFFSITE_REPORTS_COLUMNS: AppsTableColumns = [10, 21, 3, 4, 3, null];

/**
 * The `/apps/installed` ACTIVITY tab (`AppActivityPanel`) —
 * When · App · Action · **Detail** · Status.
 *
 * 🔴 `Status` IS PRIMARY, AND `Detail` — WHICH THIS LEDGER PICKED FIRST — IS THE WORST
 * CHOICE ON THE ROW. The original justification ("the variable-length cell is what the app
 * did … the sentence that matters") named the wrong column, and the component's OWN comment
 * at its render site says so: the ACTION cell carries the human sentence when a rich detail
 * is present, and the DETAIL cell always shows the raw technical ref (workflow id / storage
 * key / endpoint). Measured on a rich `tip` row, 1440 → 2560, with `Detail` primary:
 *
 *   columns        98.55 | 112.63 | 140.8 | 971.56  | 84.47
 *                 176.95 | 202.23 | 252.8 | 1744.34 | 151.67
 *   Action  glyph "Tipped 500 Buzz to user #4242"  102.97 → 166.34   (grows)
 *   Detail  glyph "POST /api/v1/buzz/tip"          151.72 → 151.72   (fixed)
 *
 * So `Detail` took +772.78 for a token that cannot use one pixel of it.
 *
 * 🔴 AND THE FIX IS NOT "MAKE `Action` PRIMARY" — that is the trap one step along. The
 * sentence is variable but BOUNDED: it grows to a few hundred px and stops, so handing it
 * ~1800px would put 1500px of dead space in the MIDDLE of the row instead of the middle-
 * right. `Action` gets a generous FIXED share (20% ≈ 506px at the current container, ~3×
 * its measured glyph) and the LAST column takes the slack, so it trails. This table has no
 * controls at all, which is why case (b)'s "action column" is really "the last column".
 *
 * 🔴 `Detail` IS 13%, NOT A SHRINK-TO-CONTENT SLIVER, and that number is again set by
 * the NARROW end. Its ref is a spaced string, so min-content is the longest WORD (~120px)
 * and a small share lets it wrap: measured at 7%, the glyph box was **115.59 at 1408**
 * against 151.72 at 2528 — the monospace ref broken across two lines on an ordinary
 * desktop. 13% of 1408 is 183, which holds it on one line at both ends. `When` and `App`
 * are 3/4 because they genuinely are shrink-to-content and stay at min-content throughout.
 */
export const APPS_ACTIVITY_COLUMNS: AppsTableColumns = [3, 4, 20, 13, null];

/**
 * The agent code-review report's scope table (`ReportTabs`) —
 * Scope · Used · Justified · Sensitive · Evidence · **Notes**.
 *
 * 🔴 NOTES IS PRIMARY. `Scope` is a fixed-shape identifier (`models:read:self`); `Used`,
 * `Justified` and `Sensitive` are booleans. The two free-text columns are `Evidence` and
 * `Notes`, and only one can be primary — `Evidence` therefore takes the largest FIXED
 * share and `Notes`, which is the reviewer's own prose and the least bounded of the two,
 * takes the slack.
 *
 * Reachable on `/apps/review/[publishRequestId]` (via `OnsiteReviewModalBody` →
 * `AgentReviewPanel`), which takes the full container — so it is in scope even though it
 * is flag-gated (`appBlocksAgenticReview`) and also renders inside a modal elsewhere. A
 * ledger is inert in the modal (the table is narrower than the sum of its min-contents
 * there) and load-bearing on the page, which is the right way round.
 */
export const APPS_AGENT_REPORT_SCOPE_COLUMNS: AppsTableColumns = [7, 5, 6, 6, 22, null];

/** Every ledger in this module, so a guard can sweep them all rather than a sample. */
export const APPS_TABLE_COLUMN_LEDGERS: Readonly<Record<string, AppsTableColumns>> = {
  'review queue (pending/rejected)': APPS_REVIEW_QUEUE_COLUMNS.withoutDeploy,
  'review queue (approved)': APPS_REVIEW_QUEUE_COLUMNS.withDeploy,
  'my apps': APPS_MINE_COLUMNS,
  'moderation listings': APPS_MOD_LISTINGS_COLUMNS,
  'revenue (unscoped)': APPS_REVENUE_COLUMNS.withApp,
  'revenue (scoped)': APPS_REVENUE_COLUMNS.scoped,
  'active previews': APPS_ACTIVE_PREVIEWS_COLUMNS,
  'offsite reports': APPS_OFFSITE_REPORTS_COLUMNS,
  'app activity': APPS_ACTIVITY_COLUMNS,
  'agent report scopes': APPS_AGENT_REPORT_SCOPE_COLUMNS,
};

/**
 * The proportional `<colgroup>` for a `/apps/*` table.
 *
 * 🔴 IT MUST BE THE TABLE'S FIRST CHILD, before `<Table.Thead>` — HTML puts `<colgroup>`
 * ahead of any row group, and only a document that says so is valid.
 *
 * ⚠️ AND THE OBVIOUS JUSTIFICATION FOR THAT RULE IS WRONG HERE, SO DO NOT REPEAT IT.
 * "A browser ignores a misplaced `<colgroup>`" is what this comment used to say, and it
 * was refuted by mutating it: measured 2026-09-04 in `AppsWideLayout.geometry.test.tsx`,
 * moving this element AFTER `<Table.Tbody>` changed no rendered width at all — every
 * geometry assertions still passed. React inserts nodes through the DOM API rather than
 * the HTML parser, so the parser's table foster-parenting never runs and Chromium applies
 * the columns from wherever the element sits. The ordering is therefore a VALIDITY rule
 * enforced structurally in `__tests__/appsWideLayout.test.ts`, not something the pixels
 * can see — and a guard whose stated reason is false is the kind that gets deleted.
 *
 * 🔴 THE PRIMARY COLUMN GETS NO `width` AT ALL, and that absence is the mechanism.
 * Under CSS automatic table layout a column with a specified width is given it; what is
 * left over goes to the columns WITHOUT one. With exactly one such column, "what is left
 * over" is the whole surplus, which is precisely "the primary column absorbs the slack".
 * Giving it a percentage instead would make it merely another proportional column and
 * the extra width would go back to being distributed as padding.
 */
export function AppsTableColgroup({ columns }: { columns: AppsTableColumns }) {
  return (
    <colgroup data-testid="apps-table-colgroup">
      {columns.map((pct, i) => (
        <col
          // The ledger is a fixed-length positional list; the index IS the column's
          // identity, and there is nothing else to key on.
          // eslint-disable-next-line react/no-array-index-key
          key={i}
          data-apps-col={pct === null ? 'primary' : String(pct)}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      ))}
    </colgroup>
  );
}

/**
 * How many tracks {@link AppsCardGrid} resolves to at a given CONTENT width — the
 * `repeat(auto-fill, minmax(min, 1fr))` arithmetic, as a pure function so the ladder
 * can be pinned without a browser.
 *
 * Mirrors the CSS: `auto-fill` fits `floor((available + gap) / (min + gap))` tracks, and
 * never fewer than one.
 */
export function appsCardGridColumnsAt(
  contentWidth: number,
  minColumn: number = APPS_CARD_LIST_MIN_COLUMN,
  gap: number = APPS_CARD_LIST_GAP
): number {
  return Math.max(1, Math.floor((contentWidth + gap) / (minColumn + gap)));
}

/** The content width a route with no measure gets from the shared container. */
export const APPS_FULL_MEASURE_CONTENT_WIDTH = APPS_PAGE_CONTAINER_WIDTH - APPS_CONTAINER_GUTTER;

/** The content width the SAME route got from the container before the ultrawide pass. */
export const APPS_LEGACY_CONTENT_WIDTH = APPS_LEGACY_CONTAINER_WIDTH - APPS_CONTAINER_GUTTER;

/**
 * A card list that spends surplus width on COLUMNS rather than on stretching one card.
 *
 * Replaces a `<Stack gap="…">` of full-width cards.
 *
 * 🔴 THE INNER `min(100%, N)` IS LOAD-BEARING, AND ITS FAILURE MODE IS WORSE THAN THIS
 * COMMENT USED TO SAY. It claimed a bare `minmax(1200px, 1fr)` "overflows horizontally".
 * Measured at 390×844 with the `min()` removed: `gridBox=358`, `gridScroll=1200`,
 * `child=1200`, and `document.scrollWidth` **unchanged** — so the card is 1200px wide
 * inside a 358px grid, CLIPPED, with no scrollbar and no page-level overflow to notice
 * it by. Nothing on screen says the content is cut off. That matters because this
 * component converted three phone-reachable `Stack`s on `/apps/installed` into grids, so
 * the narrow case is a real users' case rather than a theoretical one, and it is pinned
 * at a phone viewport in `AppsWideLayout.geometry.test.tsx`.
 *
 * `alignItems: start` is deliberate and is NOT the store grid's bug: these cards are
 * independent blocks with nothing bottom-pinned inside them (compare
 * `AppListingsMarketplaceBody.stretch.geometry.test.tsx`, where stretching is what makes
 * `h-full` resolve), so stretching them to the tallest row member would only inflate the
 * short ones.
 */
export function AppsCardGrid({
  children,
  testId,
  gap = APPS_CARD_LIST_GAP,
}: {
  children: ReactNode;
  /** Optional `data-testid`, so a page's existing list id survives the swap. */
  testId?: string;
  /**
   * Track gap in px. Defaults to {@link APPS_CARD_LIST_GAP} (Mantine `md`).
   *
   * 🔴 IT IS A PROP BECAUSE THE PROVENANCE RULE APPLIES TO SPACING TOO. The lists this
   * replaced did not all use the same gap — `/apps/installed`'s Hidden tab was
   * `<Stack gap="sm">` (12px) — and defaulting every one of them to 16 would have moved
   * something a 1440 monitor shows, which is precisely what
   * `APPS_CARD_LIST_MIN_COLUMN`'s "nothing a 1440 or 1920 monitor shows changes" claim
   * forbids. Both gaps yield the SAME column ladder at both container widths (pinned in
   * `__tests__/appsWideLayout.test.ts`), so carrying the original number costs nothing.
   */
  gap?: number;
}) {
  return (
    <div
      data-testid={testId}
      data-apps-card-grid=""
      style={{
        display: 'grid',
        gap,
        alignItems: 'start',
        gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${APPS_CARD_LIST_MIN_COLUMN}px), 1fr))`,
      }}
    >
      {children}
    </div>
  );
}
