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
 * that acts on it. Measured on `/apps/installed`, whose four
 * `Group justify="space-between" wrap="nowrap"` rows (lines 146, 231, 362, 415) each
 * moved their button 640px further from the name it belongs to. `/apps/review` had the
 * same shape and had been "fixed" by CAPPING THE PAGE at 1368 — a workaround this
 * module replaces, so that cap is deleted.
 *
 * TWO MECHANISMS, one per surface shape:
 *
 *   · A TABLE takes {@link AppsTableColgroup}. Every column except the PRIMARY one gets
 *     a percentage width; the primary gets none, so CSS's automatic table layout hands
 *     it everything left over. That is the "proportional columns, primary absorbs the
 *     slack" rule, and it is why there is exactly one `null` in each ledger below.
 *   · A CARD LIST takes {@link AppsCardGrid}. Cards go SIDE BY SIDE once the container
 *     is wide enough for two of {@link APPS_CARD_LIST_MIN_COLUMN}, so the surplus buys
 *     a column instead of stretching one card across the screen.
 *
 * 🔴 NEITHER MECHANISM MAY BE REPLACED BY A BODY CAP. Refusing the width is what the
 * container pass exists to stop doing, and a cap is invisible to every guard here —
 * see `__tests__/appsPageWidths.test.ts` for the taxonomy pins that keep these routes
 * in `APPS_FULL_MEASURE_PAGES`.
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
  withoutDeploy: [10, null, 12, 14, 10] as AppsTableColumns,
  /** Approved: Kind · App · Submitter · date · Deploy · action. */
  withDeploy: [8, null, 11, 13, 12, 8] as AppsTableColumns,
} as const;

/**
 * The `/apps/mine` table (`MyAppsBody`) — **App** · Cover · Status · Updated.
 *
 * App is primary for the same reason as above, and here it also carries the icon and
 * the slug, so it is the cell that most wants the room. Cover is a fixed 96px image, so
 * its 12% is a floor rather than an aspiration; Status holds up to three badges plus
 * the completeness advisory, which is why it is the widest fixed share.
 */
export const APPS_MINE_COLUMNS: AppsTableColumns = [null, 10, 24, 11];

/**
 * The `/apps/review` MANAGE-LISTINGS table (`AppListingsModerationTable`) —
 * **App** · Owner · Category · Reviews · actions.
 *
 * The action cell is a `Group` of buttons plus a menu, so it gets the second-largest
 * share; it still cannot be primary, because its natural width is set by its buttons
 * and handing it the slack would push the buttons away from the row again.
 */
export const APPS_MOD_LISTINGS_COLUMNS: AppsTableColumns = [null, 14, 12, 10, 22];

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
  withApp: [8, null, 12, 10, 9, 11, 11] as AppsTableColumns,
  /** `/apps/<appBlockId>/revenue`: Date · Scope · Buzz · Gross · Your share · Status. */
  scoped: [10, null, 12, 11, 13, 13] as AppsTableColumns,
} as const;

/** Every ledger in this module, so a guard can sweep them all rather than a sample. */
export const APPS_TABLE_COLUMN_LEDGERS: Readonly<Record<string, AppsTableColumns>> = {
  'review queue (pending/rejected)': APPS_REVIEW_QUEUE_COLUMNS.withoutDeploy,
  'review queue (approved)': APPS_REVIEW_QUEUE_COLUMNS.withDeploy,
  'my apps': APPS_MINE_COLUMNS,
  'moderation listings': APPS_MOD_LISTINGS_COLUMNS,
  'revenue (unscoped)': APPS_REVENUE_COLUMNS.withApp,
  'revenue (scoped)': APPS_REVENUE_COLUMNS.scoped,
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
 * moving this element AFTER `<Table.Tbody>` changed no rendered width at all — all eight
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
 * Replaces a `<Stack gap="md">` of full-width cards. `minmax(min(100%, N), 1fr)` — the
 * inner `min()` is load-bearing: a bare `minmax(1200px, 1fr)` sets a track FLOOR of
 * 1200px, so on any viewport narrower than that the grid overflows horizontally instead
 * of collapsing to one full-width card. With it, a narrow screen renders exactly what a
 * `Stack` did.
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
}: {
  children: ReactNode;
  /** Optional `data-testid`, so a page's existing list id survives the swap. */
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      data-apps-card-grid=""
      style={{
        display: 'grid',
        gap: APPS_CARD_LIST_GAP,
        alignItems: 'start',
        gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${APPS_CARD_LIST_MIN_COLUMN}px), 1fr))`,
      }}
    >
      {children}
    </div>
  );
}
