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
 * the slug, so it is the cell that most wants the room.
 *
 * 🔴 THE COMMENT THAT USED TO SIT HERE WAS WRONG IN BOTH HALVES, AND THE SECOND HALF
 * DESCRIBED THE DEFECT AS THOUGH IT WERE THE DESIGN. It read: "Cover is a fixed 96px
 * image, so its 12% is a floor rather than an aspiration; Status holds up to three
 * badges plus the completeness advisory, which is why it is the widest fixed share."
 *
 *   · COVER. The declared value was never 12 — it is 5, and it has never had any effect
 *     at any width this container reaches. Measured at 1440 (table 1406): the Cover
 *     column resolves to 128px while 5% is 70.3px, because the cell's min-content is the
 *     96px image plus the table's 2×16px horizontal padding = 128. At the container's
 *     2560 cap (table 2526) 5% is 126.3px — still under 128. So the share is INERT over
 *     the whole supported range and the column is sized by its own min-content floor.
 *     5 is kept rather than raised to 12 precisely because it is inert: 12% of 1406 is
 *     168.7px, i.e. raising it to match the sentence would take 40px off the primary
 *     column to pad a fixed-size image. The number is right; the sentence was not.
 *
 *   · STATUS. It does not hold "up to three badges" — `StatusBadges` renders exactly two
 *     (role, then status-or-owner-chip) plus the completeness advisory glyph. And 10 was
 *     not "the widest fixed share" in any useful sense: measured at 1440, that row's
 *     max-content is 185.17px + 32px padding = 217.17px against the 140.59px the 10%
 *     share resolved to, so the badges painted 60px OUTSIDE their own cell and on top of
 *     the Updated column at every width ≤ 1440 (+22px of overlap at 1280, +13 at 1366,
 *     +6 at 1440). Auto table layout could not defend the column because a `nowrap`
 *     `Group` of `flex-shrink: 0` badges reports a min-content of 78px — far below the
 *     185.17px it actually paints — so the min-content floor that normally expands a
 *     squeezed column was satisfied by a number the row never honours. The structural
 *     half of that fix is in `MyAppsBody`'s `StatusBadges` (the row may now wrap, which
 *     makes its min-content honest and overflow impossible); the share here is what
 *     keeps the ordinary row on ONE line: 18% of the 1246px table at 1280 is 224px,
 *     above the 217.17px the two badges plus the advisory need.
 *
 *   · UPDATED. 5% resolved to 88px at 1440 — under the 96.73px ("Sep 4, 2026" max-content
 *     64.73 + 32 padding) a single line needs — so the date wrapped to two lines at every
 *     width below 2560. 9% is 112px at 1280, which also covers the widest formatted date.
 *
 * The primary column still takes the surplus and still takes most of it: 100 − 32 = 68%
 * against a widest fixed share of 18%, which is what `appsTableColumnProblems` and the
 * geometry tier check.
 */
export const APPS_MINE_COLUMNS: AppsTableColumns = [null, 5, 18, 9];

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
 * 🔴 THERE IS NO `APPS_OFFSITE_REPORTS_COLUMNS` EITHER, for the same measured reason as the
 * activity table above — and this one took three wrong ledgers to establish.
 *
 * Round 2 made `App` primary, round 3 made `Reason` primary (it is
 * `lineClamp={2} maxWidth: 260`, so it absorbed +816.91 for nothing), and round 4 made the
 * actions column primary under case (b). The last one is right in KIND and still
 * unshippable, because at 1200 this row's content wants
 *
 *   App 240 + Reason 292 + Reporter 94 + Reported 133 + Status 86 + actions 414 = 1259px
 *
 * in 1168px of container. Something is under-served at 1200 whatever the split, and the
 * browser's own layout picks the least-bad one. Measured: every candidate was either
 * TALLER than natural at 1200 (105.48 / 177.88 against 88.69) or clipped the lineClamp-ed
 * details harder than natural (a 150.77px details box against 260) — and the second is
 * invisible to a row-height check, which is why the tier now A/Bs WIDTH as well as height.
 *
 * 🔴 THE `justify="flex-end"` ON ITS ACTION GROUP IS THEREFORE BACK. That flip was correct
 * ONLY as part of case (b): with no ledger the column sits at its min-content and the two
 * alignments render identically, so the flip would have been an unjustified change.
 */

/**
 * 🔴 THERE IS NO `APPS_ACTIVITY_COLUMNS`, AND THAT IS A MEASURED DECISION.
 *
 * `/apps/installed`'s activity tab (`AppActivityPanel`) carried one for two rounds and it
 * was wrong both times — first with `Detail` primary (a fixed monospace ref), then with
 * shares set from a 1408 measurement, which squeezed three columns below their content at
 * every width a real desktop uses. Measured on a rich `tip` row, ROW HEIGHT:
 *
 *                                    768      1200     1440     2560
 *   no ledger (natural)             36.19    36.19    36.19    36.19
 *   [7, 8, 10, null, 6]  (round 2)  48.09    48.09    48.09    36.19
 *   [3, 4, 20, 13, null] (round 3)  64.89    64.89    64.89    48.09
 *
 * Round 3 was 79% taller than natural at 1440 — `When` broke a `YYYY-MM-DD HH:mm` stamp
 * across THREE lines, and `App` sat pinned at its 108.52 min-content from 768 through 2560
 * so a long name was ellipsised identically on both.
 *
 * 🔴 AND NO LEDGER FIXES IT, WHICH IS THE POINT. This table's max-content sum (~735px) is
 * the container's content width AT 768, so there is no surplus to place at the narrow end.
 * Three candidates sized from 1200 all still wrapped at 768 (48.09). The one configuration
 * that holds a single line everywhere — `[16, 12, 27, 25, null]` — reproduces natural
 * layout at the wide end to within ~15px on three of five columns:
 *
 *   ledger  @2560   404.47 | 303.36 | 682.55 | 632.00 | 505.63
 *   natural @2560   411.09 | 609.14 | 667.58 | 615.19 | 225.00
 *
 * So the choice is between a ledger that wraps text on a laptop and a ledger that is
 * natural layout with extra steps. Both are worse than none, and this module's own rule —
 * a share larger than its cell needs is padding relabelled — rules out the second. The
 * table is EXEMPT; the guard in `__tests__/appsWideLayout.test.ts` records that as a
 * `no-surplus` exemption and requires a geometry arm to keep proving it.
 */

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
 * geometry assertion in that file still passed. React inserts nodes through the DOM API rather than
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
