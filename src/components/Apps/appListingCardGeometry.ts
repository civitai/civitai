/**
 * App Store Listings (W13) — the store CARD's GEOMETRY, in one place.
 *
 * 🔴 WHY THIS MODULE EXISTS: A SKELETON AND ITS CARD MUST NOT BE ABLE TO DRIFT.
 * `AppListingCardSkeleton` (a later PR) has to reserve exactly the geometry the
 * real card occupies — cover ratio, icon size, reserved title lines, action-row
 * height — or the grid visibly reflows the moment the query resolves. Two
 * hand-copied numbers is the failure mode; one imported constant is the fix.
 * `AppListingCard.tsx` READS every value below rather than spelling it, so the
 * skeleton importing the same module is enough to make the two agree by
 * construction instead of by review.
 *
 * 🔴 "READS EVERY VALUE" IS A CHECKED CLAIM, NOT A PROMISE — and it was FALSE when
 * first written. `LISTING_ACTION_ROW_HEIGHT_PX` was derived here and measured in
 * the browser suite but consumed by nothing in production, while this paragraph,
 * the card's own header and a test titled "reads every geometry constant" all said
 * otherwise (the test's list enumerated 8 of these 9). `appListingCardView.test.ts`
 * now derives that list from THIS module's `Object.keys`, so an export added below
 * and not read by the card fails the node tier, naming it. (Its exact-count
 * backstop runs AFTER that loop, deliberately — ordered first, as it was at
 * first, the failure a reader saw was a length mismatch and the constant went
 * unnamed.)
 *
 * 🔴 WHAT "THE NODE TIER" ACTUALLY BUYS — READ THIS BEFORE QUOTING A SEVERITY.
 * THE CANONICAL STATEMENT FOR THIS COMPONENT; every other comment that mentions a
 * tier defers to it. The node `unit` project **blocks pushes to `main` and is
 * REPORT-ONLY on a pull request**: `.github/workflows/lint.yml` puts
 * `continue-on-error: ${{ github.event_name == 'pull_request' }}` at JOB level on
 * `unit` (line 405) and on `geometry` (line 830). The browser `component` project
 * never blocks anything.
 *
 * So on a PR the two tiers are **equally non-gating**, and the difference is WHEN
 * a regression is caught: node catches it on the next `main` push — after the
 * merge — while browser never does. Three comments in this arc, and a severity
 * call in the PR body, were written on the premise that node gates a PR and
 * browser does not. It does not. The guards built on that premise are still worth
 * having (catching a defect one push later beats never), but do not price them as
 * merge gates. `lint.yml:377` warns about the same trap from the other side: with
 * `continue-on-error` the JOB conclusion is `success` while the step underneath is
 * `failure`, so a branch-protection rule naming "Unit tests (N)" would be inert.
 *
 * 🔴 REACT-FREE AND PURE, deliberately: the node `unit` project is the one that can
 * run without a DOM (and, per the note above, the one that at least blocks `main`),
 * so a module with no DOM dependency is one it can assert about. The values that can
 * only be MEASURED — that a 36px control plus 10px of padding really renders a
 * 46px row in the app's own stylesheet cascade — are pinned in
 * `AppListingCard.browser.test.tsx`, which renders the card for real.
 *
 * These are geometry ONLY. Kind/CTA/label logic stays in `appListingCardView.ts`.
 */

// ── Cover ────────────────────────────────────────────────────────────────────

/**
 * The cover's aspect ratio, as a CSS `aspect-ratio` value.
 *
 * A RATIO rather than a fixed height: it scales with the grid column (so widening
 * the grid actually makes the art bigger) while still deriving the box height from
 * the already-known column width BEFORE any image bytes arrive — which is what
 * keeps the card CLS-free. A skeleton reserving a fixed pixel height instead would
 * be correct at exactly one column width.
 */
export const LISTING_CARD_COVER_ASPECT_RATIO = '16 / 9';

// ── The meta block (icon + title + badges) ───────────────────────────────────
//
// 🔴 THIS HEADING USED TO READ "(icon + title + creator + rollup)" AND BOTH OF
// THOSE LEFT THE BLOCK IN ONE CHANGE (2026-09-06): the author chip was dropped
// from the store card entirely, and the recommend rollup moved to its own line
// BELOW the action row, where it now sits beside the play count. What the block
// still holds is the app icon, the two-line reserved title, and the two
// conditional badges (Beta / owner-only Incomplete).

/** The publisher app-icon avatar's edge length, in px (square). */
export const LISTING_CARD_ICON_SIZE_PX = 40;

/**
 * How many lines of the title are RESERVED — and, being the same number, how many
 * the title clamps to.
 *
 * 🔴 THE TWO ARE ONE NUMBER ON PURPOSE. Reserving fewer lines than the clamp
 * allows lets a long title push everything under it down; reserving more leaves
 * dead space under every short one. Because the reservation is a `min-height` and
 * the clamp is a `-webkit-line-clamp`, the rendered title box is exactly this many
 * lines tall for EVERY listing. Splitting these into two literals is precisely the
 * drift this module exists to prevent.
 *
 * 🔴 WHAT IT ALIGNS IS NARROWER THAN IT WAS — RE-DERIVED, not edited around. This
 * used to say "which is what puts the creator chip at the same y on every card in
 * a row". There is no creator chip on the card any more (2026-09-06) and the
 * recommend rollup left the meta block in the same change, so what the reservation
 * aligns today is the two conditional badges and the TAGLINE below the block. The
 * action row and the stats line under it are bottom-pinned by `mt="auto"` and were
 * never a function of title length, so they are not what this buys.
 */
export const LISTING_CARD_TITLE_LINES = 2;

/**
 * The title's `line-height`, unitless.
 *
 * 🔴 LOAD-BEARING, and easy to delete by accident: without it the title inherits
 * `--mantine-line-height-xl` (1.65), which at the title's 20px is 33px per line
 * rather than 24px — a ~18px card-height swing across the reserved two lines.
 */
export const LISTING_CARD_TITLE_LINE_HEIGHT = 1.2;

/**
 * The title box's reserved height, as a CSS length.
 *
 * `em`, not `px`: it resolves against the title's OWN font-size, so this stays
 * correct if the title's `size` ever moves without anyone remembering to re-derive
 * a pixel figure here.
 */
export const LISTING_CARD_TITLE_MIN_HEIGHT = `calc(${LISTING_CARD_TITLE_LINES} * ${LISTING_CARD_TITLE_LINE_HEIGHT}em)`;

// ── The action row ───────────────────────────────────────────────────────────

/**
 * Every control in the action row is this tall AND this wide — the `sm` CTA button
 * and the square `⋮` menu trigger alike.
 *
 * 🔴 IT IS THE ROW-HEIGHT CONTRACT, not a style choice. Handing the menu a
 * different `triggerSize` changes the row height, and the row lives in an `h-full`
 * grid row, so that propagates to every card in that row across the whole store.
 */
export const LISTING_ACTION_ROW_CONTROL_PX = 36;

/**
 * The action row's top padding, in px. Equal to Mantine `xs` spacing
 * (`0.625rem` at the 16px root this app ships), passed as a number so the row
 * READS this constant instead of spelling `pt="xs"` and leaving the arithmetic
 * below unverifiable.
 */
export const LISTING_ACTION_ROW_PT_PX = 10;

/**
 * The gap between the CTA and the `⋮` trigger, in px — Mantine `gap="xs"`.
 *
 * This is what the CTA's width is the row MINUS: the row holds only those two
 * children, so `cta = row − trigger − gap`.
 *
 * 🔴 THE ARITHMETIC IS UNCHANGED BUT ITS JUSTIFICATION IS NOT, SO READ THIS RATHER
 * THAN THE SENTENCE IT REPLACED. That sentence said the row holds two children
 * "with the recommend rollup moved up into the meta block". The rollup is no
 * longer in the meta block — it is a line of its own BELOW the action row, beside
 * the play count (2026-09-06). The row still holds exactly the CTA and the `⋮`
 * trigger; what changed is only WHERE the third thing went, and the two children
 * that remain are what this subtraction is about. That the row really holds two
 * and only two is asserted rather than described — `AppListingCard.browser.test.tsx`
 * checks `row.children` has length 2, and that the rollup is in neither the row
 * nor the meta block.
 */
export const LISTING_ACTION_ROW_GAP_PX = 10;

/**
 * The action row's total height, in px — DERIVED, not measured-and-retyped.
 *
 * 🔴 46px AND IT MUST STAY 46px. `pt` (10) + a 36px control. The row sits in an
 * `h-full` grid row, so a taller control here grows every card in that row across
 * the store — which is why the CTA grows HORIZONTALLY rather than up Mantine's
 * size scale (the next step, `md`, is 42px tall).
 */
export const LISTING_ACTION_ROW_HEIGHT_PX =
  LISTING_ACTION_ROW_PT_PX + LISTING_ACTION_ROW_CONTROL_PX;
