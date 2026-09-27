/**
 * The ONE spelling of "which app does a `[data-block-id=…]` selector name", plus the ONE
 * recogniser for "is this text a per-app ledger selector at all".
 *
 * 🔴 WHY THIS IS A SHARED MODULE AND NOT A REGEX COPIED PER FILE. The predicate was
 * open-coded four times across the platform width-cap ledger's guards, and — as a
 * duplicated predicate always eventually does — it was wrong at some of the sites and
 * right at others, in the same direction. Measured by running the four patterns against
 * the same selectors:
 *
 *   selector                                       membership  blockIdsIn  discriminator
 *   [data-block-id='sensei']                       sees it     sees it     sees it
 *   [data-block-id=sensei]      (unquoted, LEGAL)  BLIND       sees it     sees it
 *   [data-block-id^='sens']     (prefix, LEGAL)    BLIND       BLIND       sees it
 *
 * The blind one was the MEMBERSHIP ENUMERATION in
 * `src/components/AppBlocks/__tests__/pageBlockHostMaxWidth.test.ts` — the single
 * assertion in the repo that fires when the ledger GROWS, i.e. when the platform starts
 * imposing a width on a third-party app. So
 * `[data-app-page-frame][data-block-id*='sensei'] { --app-page-max-width: 1100px; }` was
 * a **surviving mutant**: an app capped in production with the whole node tier and the
 * whole browser tier green. It survived because every other guard is tolerant of the
 * operator forms and only the enumeration is not, and because the enumeration's
 * expectation is now `[]` — so the only direction it is ever exercised in is the one
 * where a missed spelling is a false PASS rather than a red test.
 *
 * That hole was opened by dropping the 1600px default (when the expectation was
 * `['playable-collections','sensei']` and both shipped rules were quoted, the regex was
 * demonstrably matching what shipped) and closed by this module.
 *
 * 🔴 TOLERANT OF EVERY FORM CSS ACCEPTS, DELIBERATELY, AND THE OPERATOR CASE RETURNS THE
 * OPERAND. `[data-block-id^='sens']` yields `"sens"` — not an app id, and that is the
 * point: a partial-match rule caps an unknown SET of apps, so it must trip the membership
 * enumeration rather than slip past it. A reviewer reading `+ "sens"` in the diff of a
 * failing expectation learns exactly the right thing.
 *
 * ⚠️ WHAT THIS DOES **NOT** MATCH, and why that is safe: a valueless
 * `[data-block-id]` selector, which would cap EVERY app. That form has no operand to
 * return, and it is caught one guard over instead — the "exactly ONE default declaration"
 * assertion classifies a declaration as a ledger override only when it sees an `=`, so a
 * valueless selector is counted as a second DEFAULT and fails there.
 *
 * 🔴 MEASURED, NOT REASONED, because a hand-off like that between two guards is exactly the
 * kind of claim that is true when written and false later. Adding
 * `[data-app-page-frame][data-block-id] { --app-page-max-width: 900px; }` to `globals.css`
 * fails `pageBlockHostMaxWidth.test.ts` with that assertion's own message — *"expected
 * exactly ONE DEFAULT `--app-page-max-width` declaration … expected [ Array(2) ] to have a
 * length of 1 but got 2"* (1 failed | 9 passed of 10 arms in that file — quote a count with its arm total; this
 * pair read "8 passed" for one commit after an `it` was added to that file). If that guard is ever relaxed to tolerate
 * two defaults, this form becomes a live hole and this extractor has to grow to cover it.
 *
 * 🔴 THE TRAILING CASE-SENSITIVITY FLAG IS PART OF THE GRAMMAR, AND OMITTING IT LEFT A HOLE
 * STRICTLY WORSE THAN THE ONE THIS MODULE WAS CREATED TO CLOSE. CSS allows `[attr='v' i]`
 * (and `s`), so a rule can be written
 * `[data-app-page-frame][data-block-id='sensei' i] { --app-page-max-width: 1100px; }`. A
 * pattern requiring `]` immediately after the value is blind to it. Measured, through the
 * node tier's full pipeline, against the spellings below — the `i` row is the one that got
 * away from the FIRST version of this module. ⚠️ THE TABLE HAS THREE PREDICATE COLUMNS, NOT
 * FOUR, and an earlier version of this sentence said "the four patterns" while showing three:
 * the fourth site was `ledgerSelectors` in `ledgerSelectorSurvivesProdStrip.test.ts`, which no
 * longer has a pattern of its own — it calls `isLedgerSelector` below. Counting a site the
 * measurement did not cover is how a table reads as an audit of everything.
 *
 *   selector                       blockIdsIn   discriminator   exactly-one-default   verdict
 *   [data-block-id='x']            ["x"]        ledger          pass                  RED (correct)
 *   [data-block-id=x]              ["x"]        ledger          pass                  RED (correct)
 *   [data-block-id*='x']           ["x"]        ledger          pass                  RED (correct)
 *   [data-block-id='x' i]          []           ledger          pass                  **GREEN**
 *   [data-block-id]  (valueless)   []           DEFAULT         FAIL                  RED (correct)
 *
 * The `i` row escaped on BOTH sides: `blockIdsIn` did not see the id, so membership read as
 * an empty ledger, AND the discriminator DID see an `=`, so the declaration was routed to
 * the ledger-override bucket and never reached the "second DEFAULT" assertion that catches
 * the valueless form. The flag is now accepted, so that row is RED like the others.
 *
 * ⚠️ AND THE VALUELESS ROW'S FALLBACK IS NAMED RATHER THAN GESTURED AT, because "caught one
 * guard over" is unverifiable as written. The guard is the `--app-page-max-width` is
 * declared once… assertion in
 * `src/components/AppBlocks/__tests__/pageBlockHostMaxWidth.test.ts`: with no `=` the
 * discriminator classifies the declaration as a second DEFAULT, and the exactly-one
 * expectation fails — measured, *"expected [ Array(2) ] to have a length of 1 but got 2"*
 * (1 failed | 9 passed of 10 arms in that file — quote a count with its arm total; this
 * pair read "8 passed" for one commit after an `it` was added to that file). It is covered by that ONE assertion in that ONE file: neither
 * `ledgerSelectorSurvivesProdStrip.test.ts` nor the browser tier sees the valueless form. If
 * that guard is ever relaxed to tolerate two defaults, this form becomes a live hole and
 * this extractor has to grow to cover it.
 *
 * Built fresh per call rather than hoisted as a `/g` literal so no caller can inherit
 * another's `lastIndex`. Sorted, because no caller's order is meaningful: a CSSOM walk
 * yields document order, a raw-text parse yields file order, and the two are compared.
 */
export function blockIdsIn(text: string): string[] {
  const SELECTOR =
    /\[\s*data-block-id\s*[~|^$*]?=\s*(?:'([^']*)'|"([^"]*)"|([^\]\s]+))(?:\s+[iIsS])?\s*\]/g;
  return [...text.matchAll(SELECTOR)].map((m) => (m[1] ?? m[2] ?? m[3]).trim()).sort();
}

/**
 * Does `text` contain a per-app ledger selector — i.e. a `data-block-id` attribute selector
 * WITH a value?
 *
 * 🔴 SHARED FOR THE SAME REASON `blockIdsIn` IS, AND THE MEASUREMENT THAT FORCED IT. This
 * question was spelled two more ways, and the three spellings did not agree on which strings
 * are ledger selectors:
 *
 *   · the default-vs-override discriminator in `pageBlockHostMaxWidth.test.ts` used
 *     `/\[data-block-id\s*[=~|^$*]?=/` — no tolerance for whitespace INSIDE the bracket, so
 *     the legal `[ data-block-id = 'x' ]` was classified as a DEFAULT declaration and failed
 *     the exactly-one assertion with *"the DEFAULT is conditional or duplicated"*: a false
 *     RED, under a message naming a mechanism that had not failed;
 *   · `ledgerSelectors` in `ledgerSelectorSurvivesProdStrip.test.ts` required `]` straight
 *     after the value, so it SKIPPED the `i`-flag form entirely — meaning the strip-survival
 *     and stamped-together checks silently did not cover that rule.
 *
 * Fixing the flag in `blockIdsIn` alone would have left the second of those, which is why
 * the recogniser is exported rather than the id-extractor only: one edit now reaches every
 * site that has to agree.
 *
 * ⚠️ DELIBERATELY REQUIRES A VALUE. A valueless `[data-block-id]` caps EVERY app and must NOT
 * be recognised here — it has to fall through to the exactly-one-default assertion, which is
 * the only thing that catches it. See `blockIdsIn`'s table.
 *
 * 🔴 THE TWO PATTERNS IN THIS FILE MUST NOT DIVERGE. They are byte-identical modulo capture
 * groups — verified by stripping the three capture parens from `blockIdsIn`'s source, which
 * yields this one's source exactly — and that identity is the property that makes the whole
 * hand-off sound: anything `blockIdsIn` fails to see, this fails to see too, so the declaration
 * is bucketed as a second DEFAULT and dies on the exactly-one assertion. EVERY unrecognised
 * spelling therefore fails SAFE.
 *
 * ⚠️ A ONE-SIDED EDIT DESTROYS EXACTLY THAT, and it is the likely edit: if this predicate grows
 * tolerant of a form `blockIdsIn` still misses, that form becomes invisible to the membership
 * enumeration AND to the default count at once — which is precisely the shape of the `i`-flag
 * mutant this module was written for. The sentence above ("one edit now reaches every site") is
 * true of the CALL SITES, not of the grammar, which is still written twice here. Change both, or
 * extract one source.
 */
export function isLedgerSelector(text: string): boolean {
  return /\[\s*data-block-id\s*[~|^$*]?=\s*(?:'[^']*'|"[^"]*"|[^\]\s]+)(?:\s+[iIsS])?\s*\]/.test(
    text
  );
}

/**
 * The shape of the "HOW TO ADD ONE" worked template in `src/styles/globals.css`: both selector
 * halves chained on one element, with a `--app-page-max-width` px declaration inside the block.
 * Capture group 1 is the px NUMBER.
 *
 * 🔴 SHARED BECAUSE THE SAME PR WROTE IT TWICE, AT TWO DIFFERENT TOLERANCES. The node guard
 * pinned the template's SHAPE and the browser suite derived its VALUE, each with its own
 * regex: the node one accepted any value and whitespace before the colon, the browser one
 * required quotes-or-nothing and no space. So `--app-page-max-width : 1100px`, or a template
 * that grows a `margin-inline` line first, kept one green and took two browser tests red on
 * "could not find the template" — a loud failure, but a duplicated predicate over one artifact
 * that was wrong at one site, which is the finding this module exists to retire. One pattern,
 * both tiers, and neither can drift from the other.
 *
 * ⚠️ IT DOES NOT PIN SELECTOR ORDER: `[data-block-id='x'][data-app-page-frame]` is functionally
 * identical and matches. Callers' messages say so rather than claiming "a half is missing".
 * Not `/g` — callers that need all matches build their own `RegExp` from `.source`, so no
 * caller can inherit another's `lastIndex`.
 */
export const TEMPLATE_RULE =
  /\[data-app-page-frame\]\s*\[\s*data-block-id\s*=\s*['"]?[^'"\]]+['"]?(?:\s+[iIsS])?\s*\]\s*\{[^}]*?--app-page-max-width\s*:\s*(\d+)px/;
