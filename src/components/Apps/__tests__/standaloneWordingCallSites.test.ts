import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  EMBEDDED_KIND_LABEL,
  LISTING_KIND_APP_LABELS,
  LISTING_KIND_LABELS,
  STANDALONE_KIND_LABEL,
  listingKindAppLabel,
  listingKindLabel,
} from '~/components/Apps/listingKindLabels';
import { listingKindFilterSchema } from '~/server/schema/blocks/app-listing-read.schema';
import { APP_LISTINGS_PUBLIC_EXTERNAL_FLAG } from '~/server/services/app-blocks-flag';
import {
  STORE_LISTING_KINDS,
  STORE_VISIBILITY_SCOPES,
} from '~/shared/utils/store-visibility-scope';

/**
 * 🔒 THE ENROLMENT LEDGER for the App-store listing-KIND display label.
 *
 * Modelled on its sibling `listingLabelCallSites.test.ts`, for the same measured
 * reason and in the same shape.
 *
 * ## WHY THIS FILE EXISTS — measured, not hypothetical
 *
 * The public store shipped the word **"Standalone"** for `kind='offsite'`, but the
 * label was hardcoded at each surface. Two of them said "Standalone"
 * (`AppBlockCard`'s badge, `KindFilterButtons`' toggle) while the submit flow, the
 * invites table and the transfer-offers table still said "external app". One single
 * card carried BOTH at once: `SubmitModeSelector`'s title read "List an external app
 * (connect your OAuth app)" directly above its own body text reading "List a
 * standalone app hosted elsewhere". Same component, same render, two words.
 *
 * Fixing the strings does not remove that condition — the next surface to render the
 * kind will hardcode whichever word its author last saw. So this asserts the
 * RELATIONSHIP rather than any one string:
 *
 *   (1) NO user-facing string anywhere in the App-store tree carries the retired
 *       wording — it fails when the set GROWS;
 *   (2) EVERY surface that renders the kind label resolves it from the ONE source
 *       module — it fails when the set SHRINKS (an enrolled site reverts to a
 *       hardcoded literal, which rule (1) alone would not see, because the literal
 *       it reverts to is the CORRECT word);
 *   (3) the whole normalised strings are pinned, not keywords — a guard on words is
 *       walkable by rewording, and prose is exactly the artifact that gets reworded;
 *   (4) 🔴 the LOGIC VALUES were not renamed along with the copy.
 *
 * ## 🔴 WHY (4) IS IN A COPY TEST
 *
 * The single most damaging way to "align the wording" is to align it in the database
 * column, the public `/api/v1/apps` response enum, the TypeScript unions or the Flipt
 * flag key. Those are contracts with consumers who never see this UI. A copy change
 * that renamed `'offsite'` would typecheck, render correctly, and break the public
 * API. So the constraint is asserted here, next to the change that would violate it.
 *
 * ## 🔴 WHAT THIS DOES NOT DO
 *
 * Rule (2) is structural: it proves a surface does not hardcode the word, not that
 * the helper received the right `kind`. `listingKindLabel(somethingElse)` passes it.
 * Behavioural cover lives alongside and is deliberately not replaced by it —
 * `SubmitModeSelector.browser.test.tsx`, `CliSubmitCta.browser.test.tsx` and
 * `ExternalSubmitForm.browser.test.tsx`. Read this as a reversion guard.
 */

const SRC = path.resolve(__dirname, '../../..');

/** Every App-store surface that can render a listing kind to a human. */
const SCAN_ROOTS = ['components/Apps', 'components/AppBlocks', 'pages/apps'];

/**
 * 🔴 THE ROOTS FOR THE **TEST** SWEEP, AND WHY THEY ARE A SEPARATE LIST.
 *
 * `SCAN_ROOTS` above walks PRODUCTION files only — `walk()` excludes `*.test.ts(x)` /
 * `*.browser.test.ts(x)` by construction. That exclusion is correct for the enrolment
 * rules (a test SHOULD pin a label as a literal; deriving the expectation from the
 * constant is the vacuous-test failure this repo bans), but it left a hole the size of
 * a directory: **a test asserting a RETIRED wording is on screen was invisible to every
 * rule in this file.**
 *
 * 🔴 MEASURED, NOT HYPOTHETICAL. `src/tests/pages/apps/invites-transfer-blocked.browser
 * .test.tsx` asserted `toHaveTextContent(/On-site app/i)`. The kind rename made that
 * assertion false, every rule here stayed green, the whole `unit` tier stayed green, and
 * the only thing that caught it was the preview pipeline's `component-tests` job — which
 * is report-only, runs 187 files (not the App-store subset), and is the tier a local
 * `vitest src/components/Apps` run cannot see. Note the shape: this file's docblock
 * claims rule (1) fails "when the set GROWS", and for `src/tests/**` it could not. A
 * guard narrower than its own description reads as coverage while providing none.
 *
 * `src/tests` is the page-level suite (it is NOT reached by `SCAN_ROOTS`, which are all
 * under `src/components` and `src/pages`), and the App-store component tests sit beside
 * their components, so both are listed.
 */
const TEST_SCAN_ROOTS = ['tests', 'components/Apps', 'components/AppBlocks', 'pages/apps'];

/**
 * The retired wordings.
 *
 * 🔴 Deliberately NOT a bare `offsite` / lowercase `external`. `'offsite'` is a stored
 * VALUE (the Prisma column, the REST enum, the `StoreListingKind` union) and appears in
 * hundreds of legitimate places; lowercase `'external'` is likewise the `SubmitMode` id,
 * a testid fragment and a glyph key. A rule that matched either would be allowlisted
 * into uselessness, or would push someone into renaming the value to satisfy it — the
 * one outcome rule (4) exists to prevent.
 *
 * 🔴 THE PHRASE-ONLY VERSION OF THIS LIST WAS TOO NARROW, MEASURED. It held only
 * `external app` / `off-site` / `offsite app`, so a surface rendering the kind as a
 * BARE one-word label was invisible to it. Two live instances survived the whole #4247
 * sweep that way: `myAppsView.listingKindLabel` (a shadowing duplicate returning
 * `'On-site' | 'External'`, which is what `/apps/mine` actually rendered) and
 * `unifiedReviewRow`'s `badge: 'External'` on the moderator queue. Both spelled a
 * retired word in a string no phrase pattern could match. So the list now also carries:
 *
 *   - `/^\s*External\s*$/` — CASE-SENSITIVE and WHOLE-STRING. Capital-E `External`
 *     standing alone is only ever a rendered label; lowercase `external` is a value
 *     (see above), and `External` inside a longer phrase ("External site", the heading
 *     over an outbound URL on the public listing page) is ordinary English about a
 *     website rather than the kind's name. This is the same case-based discriminator
 *     {@link KIND_LABEL_WORD} already uses for `Standalone` vs `standalone`.
 *   - `/\bon-site\b/i` — HYPHENATED, anywhere, either case. The hyphen is what makes
 *     this safe to match as a substring: the stored values are `onsite` / `offsite`
 *     with NO hyphen, so a hyphenated `on-site` can only ever be copy. That is the
 *     identical reasoning behind the pre-existing `/off-site/i`, which has always been
 *     a substring rule for the same reason.
 *
 * 🔴 WHAT THIS STILL DOES NOT COVER, stated rather than implied: a retired word inside
 * a longer phrase that is not one of the four patterns — `"External-link submissions"`
 * on the moderator queue is the live example. Widening to catch it would also catch
 * `"External site"`, and there is no mechanical rule separating the two. It is left
 * uncaught deliberately; the ledger's claim is bare LABELS plus the four phrases.
 */
const RETIRED_WORDINGS: RegExp[] = [
  /external app/i,
  /off-site/i,
  /offsite app/i,
  /^\s*External\s*$/,
  /\bon-site\b/i,
];

/**
 * The kind labels as a human reads them. Capital-S `Standalone` / capital-E `Embedded`
 * as whole words are the kinds' NAMES; lowercase `standalone` is an ordinary English
 * adverb/adjective and is deliberately NOT matched — see ALLOWED_LOWERCASE_PROSE for
 * why that distinction is load-bearing rather than lazy.
 *
 * 🔴 `Embedded` JOINED THIS RULE WITH THE RENAME, so the on-site label gets the same
 * GROWS protection the off-site one has always had — otherwise a new surface could
 * hardcode `'Embedded'` and no rule in this file would see it (it is the CORRECT word,
 * so the retired-wording rule cannot, and it is not enrolled, so the SHRINKS rules
 * cannot either). Measured before adding it: `Embedded` appeared in **0** user-facing
 * strings across the scan roots, so this pins a clean floor rather than grandfathering.
 *
 * 🔴 `\bEmbedded\b` DOES NOT MATCH `Embedding`, and that is the whole point of the
 * word-boundary form. `AppSettingsModal`'s `MODEL_TYPE_OPTIONS` renders `'Embedding'`
 * for `ModelType.TextualInversion` — the collision the rename was once deferred over.
 * That model-type label is NOT renamed and must stay matchable by nothing here.
 */
const KIND_LABEL_WORD = /\bStandalone\b|\bEmbedded\b/;

/**
 * 🔴 WHY LOWERCASE `standalone` IS OUT OF SCOPE, recorded so nobody "tightens" this
 * rule into a wrong one.
 *
 * `pages/apps/[appBlockId]/index.tsx` renders, in the NON-external branch, "Preview
 * of the standalone block at …" and "this standalone preview does not". That
 * `standalone` means *served from its own origin, apart from the model page* — it is
 * describing an **on-site** app. Capitalising it would label an on-site app with the
 * offsite kind's name: not a cosmetic slip, an actively false statement on a public
 * listing page. `components/AppBlocks/AppAnalyticsPanel.tsx` ("Page apps run
 * standalone and are not installed onto a model") is the same word in the same
 * ordinary sense.
 *
 * So the rule keys on the CAPITALISED whole word, which only ever names the kind.
 */
const ALLOWED_LOWERCASE_PROSE =
  'lowercase `standalone` is ordinary English (an on-site app served at its own origin), not the kind name';

/**
 * Files whose retired-wording string is CORRECT and must stay. Each needs a reason —
 * an allowlist without one is how a real defect gets parked.
 *
 * Empty by design: every occurrence found in the sweep was genuine copy drift and was
 * fixed rather than parked. A future entry is a decision that has to be argued.
 */
const ALLOWED_RETIRED_WORDING: Record<string, string> = {};

/**
 * 🔒 THE ENROLMENT SET: every surface that renders the kind label to a human.
 *
 * A file in this list must resolve the word from `listingKindLabels`. A file NOT in
 * this list must not contain the word at all. Both halves are asserted, which is what
 * makes the ledger fail on a GROW *and* on a SHRINK.
 */
const ENROLLED: Record<string, string> = {
  'components/Apps/AppBlockCard.tsx': 'store card kind badge',
  'components/Apps/KindFilterButtons.tsx': 'store kind filter toggles',
  'components/Apps/AppInvitesBody.tsx': 'collaborator-invite kind badge',
  'components/Apps/AppTransferOffersView.tsx': 'ownership-transfer kind badge',
  'components/Apps/AppEarningsPanel.tsx': 'earnings-unavailable explanation',
  'components/Apps/SubmitModeSelector.tsx': 'submit mode-picker card title + body',
  'components/Apps/ExternalSubmitForm.tsx': 'submit wizard header + draft-created note',
  'pages/apps/submit.tsx': 'submit page subtitle',
  'pages/apps/[appBlockId]/index.tsx': 'public listing external-destination disclosure',
  // 🔴 THE FOUR THIS LEDGER FOUND. None of them was in the reported defect, and
  // none was reachable by reading the submit flow — they were spelling the CORRECT
  // word, so no copy sweep would have surfaced them either. `appListingCardView`
  // and `appListingDetailRows` each carried a comment claiming to mirror the other's
  // wording, and they did not: the badge said "Standalone" while the detail row said
  // "On-site app" / "Standalone" — the suffix on one branch and not the other.
  'components/Apps/appListingCardView.ts': 'store card kind badge label',
  'components/Apps/appListingDetailRows.ts': 'listing detail "Kind" row',
  'components/Apps/OffsiteReviewQueue.tsx': 'moderator queue + reports section headings',
  // 🔴 THE FIVE THE WIDENED RETIRED-WORDING RULE FOUND (PR A). Every one rendered a
  // BARE one-word kind label, which the phrase-only rule structurally could not see —
  // see the note on RETIRED_WORDINGS. Four of them were spelling a RETIRED word in
  // production; the fifth (`appListingCardView`'s onsite branch, `'App'`) was spelling
  // a word that is not the kind's name at all.
  'components/Apps/unifiedReviewRow.ts': 'moderator queue kind-column badge',
  'components/Apps/AppListingsModerationTable.tsx': 'moderation table kind SegmentedControl',
  'components/Apps/appListingModerationTableView.ts': 'moderation table per-row kind chip',
  'pages/apps/mine.tsx': '/apps/mine page subtitle naming both kinds',
  'pages/apps/review.tsx': '/apps/review page subtitle naming both kinds',
};

/**
 * 🔴 `components/Apps/MyAppsBody.tsx` AND `components/Apps/myAppsView.ts` ARE
 * DELIBERATELY ABSENT FROM {@link ENROLLED}, and the absence is a decision, not an
 * oversight.
 *
 * `/apps/mine` no longer renders a kind AT ALL — the row's kind badge was deleted (the
 * author knows what they built; the kind lives on the listing detail and edit pages).
 * Enrolling a surface asserts it RESOLVES the word from the one source, which is only a
 * meaningful claim about a surface that renders one; enrolling a page that renders none
 * would make the SHRINKS rules pass on an import kept alive for nothing.
 *
 * The absence is pinned where it can actually be observed — `MyAppsBody.browser.test.tsx`
 * asserts no row shape emits the kind-badge testid — so restoring the badge is a visible
 * change rather than a silent one. `myAppsView.ts`'s own shadowing `listingKindLabel` is
 * DELETED (see that file's header); it is not re-pointed at the canonical module.
 */
const DELIBERATELY_UNENROLLED: Record<string, string> = {
  'components/Apps/MyAppsBody.tsx': '/apps/mine renders no kind label at all — badge deleted',
  'components/Apps/myAppsView.ts': 'the shadowing listingKindLabel was deleted, not re-pointed',
};

/** The one module allowed to spell the word as a literal. */
const LABEL_SOURCE_REL = 'components/Apps/listingKindLabels.ts';
const LABEL_SOURCE_IMPORT = '~/components/Apps/listingKindLabels';

function parseTsx(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|browser\.test)\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** The MIRROR of {@link walk}: test files ONLY. See {@link TEST_SCAN_ROOTS}. */
function walkTests(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTests(full, out);
    else if (/\.(test|browser\.test)\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Every string a HUMAN could read in this source, as `{ line, text }`.
 *
 * 🔴 COMMENTS ARE STRUCTURALLY EXCLUDED, and that is the reason this is an AST walk
 * rather than a grep. This very file, and most files it scans, discuss the retired
 * wording at length in their own docstrings — the phrase "external app" appears in
 * the prose explaining why it was retired. A regex over raw text would flag every one
 * of those, the rule would be silenced with an allowlist, and it would then be blind
 * to the real thing. TypeScript's AST does not surface comments as nodes here, so the
 * exclusion is a property of the walk and cannot be forgotten.
 *
 * Collects string / no-substitution-template literals, template SPANS (the literal
 * chunks around `${…}`), and JSX text.
 */
function userFacingStrings(fileName: string, text: string): { line: number; text: string }[] {
  const sf = parseTsx(fileName, text);
  const out: { line: number; text: string }[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      // An import/export specifier is a module path, never copy.
      const p = node.parent;
      if (!ts.isImportDeclaration(p) && !ts.isExportDeclaration(p)) {
        out.push({ line: at(node), text: node.text });
      }
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      out.push({ line: at(node), text: node.text });
    } else if (ts.isJsxText(node)) {
      const t = node.text.trim();
      if (t.length > 0) out.push({ line: at(node), text: t });
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/** Retired-wording hits in one source, as `line:phrase` strings. */
function findRetiredWording(fileName: string, text: string): string[] {
  return userFacingStrings(fileName, text).flatMap(({ line, text: s }) => {
    const hit = RETIRED_WORDINGS.find((re) => re.test(s));
    return hit ? [`${line}:${hit.source}`] : [];
  });
}

/** Hardcoded kind-label hits in one source, as `line` strings. */
function findHardcodedKindLabel(fileName: string, text: string): string[] {
  return userFacingStrings(fileName, text).flatMap(({ line, text: s }) =>
    KIND_LABEL_WORD.test(s) ? [String(line)] : []
  );
}

/**
 * 🔴 TEXT A TEST ASSERTS IS **ON SCREEN** — not a test title, not fixture data.
 *
 * This is the whole reason the test sweep is a separate extractor rather than
 * `userFacingStrings` pointed at a wider root. Measured over the 286 test files in
 * `TEST_SCAN_ROOTS`, the naive version produced **7** retired-wording hits of which
 * **6 were noise**: five were `test(...)` / `describe(...)` TITLES naming the SCENARIO
 * ("🔴 an ON-SITE listing — transfer stays available" — a true sentence about the
 * fixture's `kind`, not a claim about copy), and one was an app-name fixture
 * (`name: 'Offsite App'`). Six false positives out of seven is precisely the
 * "allowlisted into uselessness" outcome this file's own `RETIRED_WORDINGS` docblock
 * warns about, and it would have buried the one real hit.
 *
 * So the rule keys on the ONE thing that makes a string a claim about rendered copy:
 * it is an argument to a text-matching assertion. Collected:
 *   - the argument to `toHaveTextContent` / `toHaveAccessibleName` and the
 *     `*ByText` / `*ByLabelText` / `*ByAltText` / `*ByTitle` / `*ByPlaceholderText`
 *     query family (string, template or REGEX — the live defect was a regex);
 *   - the `name:` option of `getByRole(role, { name })`, which is how this repo
 *     addresses a button by its accessible name;
 *   - the value of `toHaveAttribute('aria-label' | 'title' | 'alt', …)`.
 *
 * 🔴 WHAT IT DOES NOT COVER, stated rather than implied: `toBe` / `toEqual` on a
 * view-model field (`expect(row.badge).toBe('Standalone')`). That is a claim about a
 * FUNCTION'S RETURN, not about the screen, and widening to it would re-admit every
 * fixture literal in the repo. Those call sites are covered instead by the production
 * SHRINKS/GROWS rules on the module the function lives in.
 */
const TEXT_ASSERTION_CALLS = new Set([
  'toHaveTextContent',
  'toHaveAccessibleName',
  'getByText',
  'findByText',
  'queryByText',
  'getByLabelText',
  'findByLabelText',
  'queryByLabelText',
  'getByAltText',
  'getByTitle',
  'getByPlaceholderText',
]);
const ROLE_QUERY_CALLS = new Set(['getByRole', 'findByRole', 'queryByRole']);
const LABELLING_ATTRS = new Set(['aria-label', 'title', 'alt']);

function assertedScreenText(fileName: string, text: string): { line: number; text: string }[] {
  const sf = parseTsx(fileName, text);
  const out: { line: number; text: string }[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  /** The literal text of a string / template / REGEX argument, or null if it is dynamic. */
  const literalOf = (n: ts.Node): string | null => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    // A regex's SOURCE is the assertion — `/On-site app/i` is the live defect's shape.
    if (ts.isRegularExpressionLiteral(n)) return n.text;
    if (ts.isTemplateExpression(n)) {
      return [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(' ');
    }
    return null;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      if (TEXT_ASSERTION_CALLS.has(name)) {
        for (const a of node.arguments) {
          const v = literalOf(a);
          if (v !== null) out.push({ line: at(a), text: v });
        }
      } else if (ROLE_QUERY_CALLS.has(name) && node.arguments.length >= 2) {
        const opts = node.arguments[1];
        if (ts.isObjectLiteralExpression(opts)) {
          for (const p of opts.properties) {
            if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'name') {
              const v = literalOf(p.initializer);
              if (v !== null) out.push({ line: at(p.initializer), text: v });
            }
          }
        }
      } else if (name === 'toHaveAttribute' && node.arguments.length >= 2) {
        const attr = literalOf(node.arguments[0]);
        if (attr !== null && LABELLING_ATTRS.has(attr)) {
          const v = literalOf(node.arguments[1]);
          if (v !== null) out.push({ line: at(node.arguments[1]), text: v });
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/** Retired-wording hits among the text a TEST asserts is on screen. */
function findAssertedRetiredWording(fileName: string, text: string): string[] {
  return assertedScreenText(fileName, text).flatMap(({ line, text: s }) => {
    const hit = RETIRED_WORDINGS.find((re) => re.test(s));
    return hit ? [`${line}:${hit.source}`] : [];
  });
}

/**
 * Does this source REALLY import the one label module?
 *
 * 🔴 AN AST WALK, NOT `raw.includes(LABEL_SOURCE_IMPORT)`, AND THE SUBSTRING FORM WAS
 * MEASURABLY WRONG — it counted a mention of the module path in a COMMENT as an import.
 * That is the same defect the whole file avoids for retired wordings (see
 * `userFacingStrings`), reappearing in the enrolment half: every file here discusses
 * this module in prose, so a surface could revert to a hardcoded literal, keep one
 * sentence of docstring naming the module, and satisfy the SHRINKS rule while importing
 * nothing. Found by dogfooding — the deliberately-unenrolled check below went red on a
 * file whose only occurrence of the path was in its own explanatory header.
 *
 * ONE predicate, used by BOTH the SHRINKS rule and the unenrolled rule, so the two
 * cannot drift apart and disagree about what "enrolled" means.
 */
function importsLabelSource(fileName: string, text: string): boolean {
  const sf = parseTsx(fileName, text);
  return sf.statements.some(
    (st) =>
      ts.isImportDeclaration(st) &&
      ts.isStringLiteral(st.moduleSpecifier) &&
      st.moduleSpecifier.text === LABEL_SOURCE_IMPORT
  );
}

// ---------------------------------------------------------------------------
// 🔴 VALIDATE THE INSTRUMENT BEFORE READING ITS VERDICT.
//
// The assertions this file exists for are ZEROS, and a reassuring zero is
// indistinguishable from a scanner wired to nothing. Every control below runs
// against a SYNTHETIC source, so none of them can go stale when the tree changes.
// ---------------------------------------------------------------------------
describe('🔴 the scanner (negative + positive controls)', () => {
  it('POSITIVE CONTROL: it FINDS every retired-wording shape', () => {
    const bad = `
      export function S() {
        const heading = 'List an external app';
        const sub = \`a pending off-site listing for \${name}\`;
        const chip = { label: 'External', value: 'offsite' };
        return (
          <div>
            <Badge title="External App">On-site and external</Badge>
            <Text>This is an offsite app that opens elsewhere.</Text>
            <Alert label={'Off-Site destination'} />
          </div>
        );
      }`;
    const hits = findRetiredWording('bad.tsx', bad);
    // 'external app', 'off-site', bare 'External', 'External App', the JSX text
    // "On-site and external", 'offsite app', 'Off-Site' = 7.
    //
    // 🔴 THE LAST TWO ARE THE WIDENING, AND THIS COMMENT USED TO ASSERT THE OPPOSITE.
    // It read: `the JSX text "On-site and external" is NOT a hit — "external" alone is
    // not a banned phrase`. True of the phrase rule, and precisely the narrowness that
    // let `/apps/mine` and `unifiedReviewRow` render a BARE retired label undetected.
    // A bare capital-E `External` and a hyphenated `on-site` are hits now.
    expect(hits).toHaveLength(7);
  });

  /**
   * 🔴 THE TWO NEW RULES, EXERCISED AGAINST THE FORMS THEY MUST **NOT** MATCH. Each is
   * a narrowness claim made in the RETIRED_WORDINGS docblock, driven through the
   * scanner rather than asserted in prose.
   */
  it('POSITIVE + NEGATIVE CONTROL: bare `External` and hyphenated `on-site`', () => {
    // Hits: the bare label in every render shape a label takes.
    const bareLabels = `
      export function S() {
        const a = [{ value: 'offsite', label: 'External' }];
        return (
          <div>
            <Badge>External</Badge>
            <Text title="On-site" />
            <Alert label={'On-site app'} />
          </div>
        );
      }`;
    expect(findRetiredWording('bare.tsx', bareLabels)).toHaveLength(4);

    // 🔴 MISSES: lowercase `external` is the `SubmitMode` id, a testid fragment and a
    // glyph key — matching it would force a VALUE rename, which rule (4) forbids.
    // And `External` inside a phrase is ordinary English about a website.
    const notLabels = `
      export function S({ mode }: { mode: string }) {
        onSelect('external');
        const t = 'apps-submit-mode-card-external';
        return (
          <div data-testid={t}>
            <Title>External site</Title>
            <Text>Open external site</Text>
            <Text>Update your external-link app.</Text>
          </div>
        );
      }`;
    expect(findRetiredWording('notlabels.tsx', notLabels)).toEqual([]);

    // 🔴 AND THE UNHYPHENATED STORED VALUES SURVIVE — `onsite` is a value, `on-site`
    // is copy, and only the hyphen separates them.
    const values = `export const k = { a: 'onsite', b: 'offsite' };`;
    expect(findRetiredWording('values.tsx', values)).toEqual([]);
  });

  it('POSITIVE CONTROL: it FINDS a hardcoded kind label in every render shape', () => {
    const bad = `
      export function S() {
        const opts = [{ value: 'offsite', label: 'Standalone' }];
        return (
          <div>
            <Badge>Standalone</Badge>
            <Text title="Standalone app" />
            <Text>{\`a pending Standalone submission\`}</Text>
            <Badge>Embedded</Badge>
            <Text title="Embedded app" />
          </div>
        );
      }`;
    expect(findHardcodedKindLabel('bad.tsx', bad)).toHaveLength(6);
  });

  /**
   * 🔴 THE COLLISION THE RENAME WAS ONCE DEFERRED OVER, AS A NEGATIVE CONTROL. If
   * `KIND_LABEL_WORD` is ever loosened to a stem (`/Embedd/`, `/\bEmbed/`), this goes
   * red — and it must, because `'Embedding'` is `ModelType.TextualInversion`'s public
   * label in `AppSettingsModal`, not a listing kind, and is deliberately unrenamed.
   */
  it('NEGATIVE CONTROL: the model-type label `Embedding` is NOT the kind label', () => {
    const modelTypes = `
      const MODEL_TYPE_OPTIONS = [
        { value: ModelType.TextualInversion, label: 'Embedding' },
        { value: ModelType.LORA, label: 'LoRA' },
      ];`;
    expect(findHardcodedKindLabel('modeltypes.tsx', modelTypes)).toEqual([]);
    expect(findRetiredWording('modeltypes.tsx', modelTypes)).toEqual([]);
  });

  it('NEGATIVE CONTROL: the ENROLLED form is not flagged', () => {
    const good = `
      import { STANDALONE_KIND_LABEL, listingKindAppLabel } from '~/components/Apps/listingKindLabels';
      export function S({ kind }: { kind: 'onsite' | 'offsite' }) {
        return (
          <div>
            <Badge>{STANDALONE_KIND_LABEL}</Badge>
            <Badge>{listingKindAppLabel(kind)}</Badge>
            <Text>{\`List a \${STANDALONE_KIND_LABEL} app hosted elsewhere\`}</Text>
          </div>
        );
      }`;
    expect(findRetiredWording('good.tsx', good)).toEqual([]);
    expect(findHardcodedKindLabel('good.tsx', good)).toEqual([]);
  });

  /**
   * 🔴 THE CONTROL THAT MAKES THIS AN AST WALK. A grep-based version of this rule
   * flags its own explanatory comments, gets allowlisted, and goes blind. If comments
   * ever start being scanned, this goes red and names the reason.
   */
  it('NEGATIVE CONTROL: prose in COMMENTS is never scanned', () => {
    const commented = `
      // The old copy said "List an external app" and the badge said Standalone.
      /**
       * An off-site listing used to be called an external app. Retired wording:
       * "External App", "off-site", "Standalone".
       */
      export const x = 1;`;
    expect(findRetiredWording('commented.tsx', commented)).toEqual([]);
    expect(findHardcodedKindLabel('commented.tsx', commented)).toEqual([]);
  });

  /**
   * 🔴 THE CONTROL FOR RULE (4)'s BLAST RADIUS. The stored value must survive the
   * copy rule — if the scanner ever matched a bare `offsite`, the only way to make a
   * normal component pass would be to rename the value, which is the failure this
   * whole file is guarding against.
   */
  it('NEGATIVE CONTROL: the stored VALUE `offsite` is never flagged as copy', () => {
    const values = `
      export function S({ kind }: { kind: string }) {
        const isExternal = kind === 'offsite';
        mutate({ kind: 'offsite', scope: 'public-external' });
        return <Select value={kind} data={[{ value: 'offsite', label: LABELS.offsite }]} />;
      }`;
    expect(findRetiredWording('values.tsx', values)).toEqual([]);
    expect(findHardcodedKindLabel('values.tsx', values)).toEqual([]);
  });

  it('lowercase `standalone` is deliberately NOT the kind label', () => {
    const prose = `
      export function S() {
        return <Text>Preview of the standalone block at its own origin.</Text>;
      }`;
    expect(findHardcodedKindLabel('prose.tsx', prose)).toEqual([]);
    expect(ALLOWED_LOWERCASE_PROSE.length).toBeGreaterThan(20);
  });
});

const SCANNED = SCAN_ROOTS.flatMap((root) => walk(path.join(SRC, root))).map((file) => ({
  rel: path.relative(SRC, file).split(path.sep).join('/'),
  raw: fs.readFileSync(file, 'utf8'),
}));

const SCANNED_TESTS = TEST_SCAN_ROOTS.flatMap((root) => walkTests(path.join(SRC, root))).map(
  (file) => ({
    rel: path.relative(SRC, file).split(path.sep).join('/'),
    raw: fs.readFileSync(file, 'utf8'),
  })
);

describe('🔴 NO TEST ASSERTS A RETIRED WORDING IS ON SCREEN', () => {
  /**
   * 🔴 THE CONTROLS COME FIRST, because this rule's headline assertion is a ZERO and a
   * reassuring zero is indistinguishable from an extractor wired to nothing. Both
   * directions are driven through synthetic sources whose answer is known, so neither
   * can go stale when the tree changes.
   */
  it('POSITIVE CONTROL: it FINDS a retired wording in every assertion shape', () => {
    const bad = `
      test('a scenario about an on-site listing', async () => {
        await expect.element(card).toHaveTextContent(/On-site app/i);
        await expect.element(page.getByText('an external app')).toBeInTheDocument();
        await expect.element(page.getByRole('button', { name: 'Off-site thing' })).toBeVisible();
        await expect.element(el).toHaveAttribute('aria-label', 'the off-site one');
      });`;
    // FOUR hits — one per shape. The test TITLE also contains "on-site" and is NOT one
    // of them; that is the whole point of the extractor.
    expect(findAssertedRetiredWording('bad.browser.test.tsx', bad)).toHaveLength(4);
  });

  /**
   * 🔴 THE CONTROL THAT JUSTIFIES THE EXTRACTOR'S NARROWNESS. Measured on the real tree,
   * the naive "every user-facing string" version produced 7 hits of which 6 were these
   * two shapes. If someone later "simplifies" this rule to reuse `userFacingStrings`,
   * this goes red and names the reason.
   */
  it('NEGATIVE CONTROL: a test TITLE and FIXTURE DATA are not screen claims', () => {
    const noise = `
      const CATALOG = [{ id: 'a', kind: 'offsite', name: 'Offsite App' }];
      describe('🔴 an ON-SITE listing — transfer stays available', () => {
        test('…and the off-site payload renders the other way', async () => {
          state.context = contextFor({ kind: 'offsite' });
          expect(row.badge).toBe('External');
        });
      });`;
    expect(findAssertedRetiredWording('noise.browser.test.tsx', noise)).toEqual([]);
    // …and the naive extractor DOES flag them, which is why the two are different
    // functions rather than one shared one.
    expect(findRetiredWording('noise.browser.test.tsx', noise).length).toBeGreaterThan(0);
  });

  it('NEGATIVE CONTROL: the CURRENT wording asserted on screen is fine', () => {
    const good = `
      test('renders the kind', async () => {
        await expect.element(card).toHaveTextContent(/Embedded app/i);
        await expect.element(page.getByText('Standalone app')).toBeInTheDocument();
        await expect.element(page.getByRole('button', { name: 'Embedded' })).toBeVisible();
      });`;
    expect(findAssertedRetiredWording('good.browser.test.tsx', good)).toEqual([]);
  });

  /**
   * 🔴 A FLOOR ON THE TEST SWEEP ITSELF — the same reason `SCANNED` has one. A
   * `TEST_SCAN_ROOTS` typo, or a `walkTests` that silently matches nothing, turns the
   * rule below into a green no-op. Both numbers are asserted: the FILE count (the walk
   * reached the directories) and the EXTRACTED-ASSERTION count (the extractor actually
   * pulled screen claims out of them). A widened root that finds nothing is
   * indistinguishable from one wired to nothing.
   */
  it('POSITIVE CONTROL: the test sweep really visited the suites', () => {
    expect(SCANNED_TESTS.length).toBeGreaterThan(200);
    const rels = SCANNED_TESTS.map((s) => s.rel);
    // The specific file the live defect lived in, named so a move is loud.
    expect(rels).toContain('tests/pages/apps/invites-transfer-blocked.browser.test.tsx');
    // …and `src/tests/**` is genuinely reached, which NO other rule in this file does.
    expect(rels.filter((r) => r.startsWith('tests/')).length).toBeGreaterThan(20);
    const extracted = SCANNED_TESTS.reduce(
      (n, { rel, raw }) => n + assertedScreenText(rel, raw).length,
      0
    );
    expect(extracted).toBeGreaterThan(500);
  });

  /**
   * 🔴 THE RULE. A test that asserts a retired wording is on screen is either testing a
   * surface that was never renamed, or it is a stale expectation that will fail the
   * moment the rename lands — and it fails in the REPORT-ONLY browser tier, hours later,
   * on a job that runs 187 files rather than the App-store subset a developer runs
   * locally.
   */
  it('🔴 no test asserts a retired wording is rendered', () => {
    const offenders = SCANNED_TESTS.flatMap(({ rel, raw }) =>
      findAssertedRetiredWording(rel, raw).map((h) => `${rel}:${h}`)
    );
    expect(offenders).toEqual([]);
  });
});

describe('🔒 the App-store kind label has ONE source', () => {
  /**
   * 🔴 A ROW FLOOR ON THE SCANNER ITSELF. Without it, a `SCAN_ROOTS` typo or a
   * directory rename turns this whole file into a green no-op — the exact failure
   * mode the ledger is here to prevent, one level up.
   */
  it('POSITIVE CONTROL: the scan actually visited the App-store tree', () => {
    expect(SCANNED.length).toBeGreaterThan(60);
    const rels = SCANNED.map((s) => s.rel);
    for (const rel of Object.keys(ENROLLED)) expect(rels).toContain(rel);
    expect(rels).toContain(LABEL_SOURCE_REL);
  });

  it('🔴 no user-facing string carries the retired wording', () => {
    const offenders = SCANNED.flatMap(({ rel, raw }) =>
      rel in ALLOWED_RETIRED_WORDING ? [] : findRetiredWording(rel, raw).map((h) => `${rel}:${h}`)
    );
    // Listed in full on failure: the message IS the fix instructions.
    expect(offenders).toEqual([]);
  });

  /**
   * 🔴 THE "GROWS" HALF. A new surface that hardcodes `'Standalone'` — the CORRECT
   * word, so the rule above cannot see it — is caught here and only here.
   */
  it('🔴 GROWS: no un-enrolled surface hardcodes the kind label', () => {
    const offenders = SCANNED.flatMap(({ rel, raw }) =>
      rel === LABEL_SOURCE_REL || rel in ENROLLED
        ? []
        : findHardcodedKindLabel(rel, raw).map((line) => `${rel}:${line}`)
    );
    expect(offenders).toEqual([]);
  });

  /**
   * 🔴 THE "SHRINKS" HALF. An enrolled surface that stops importing the source has
   * reverted to a literal (or dropped the label entirely) — invisible to both rules
   * above, because a hardcoded `'Standalone'` in an ENROLLED file is exempted by the
   * rule above and is the right word for the rule before it.
   */
  it('🔴 SHRINKS: every enrolled surface resolves the label from the ONE source', () => {
    const unenrolled = Object.keys(ENROLLED).filter((rel) => {
      const raw = fs.readFileSync(path.join(SRC, rel), 'utf8');
      return !importsLabelSource(rel, raw);
    });
    expect(unenrolled).toEqual([]);
  });

  it('🔴 SHRINKS: no enrolled surface re-hardcodes the label beside the import', () => {
    // Importing the source and ALSO spelling the word is the half-revert: it looks
    // enrolled to the rule above while rendering a literal.
    const offenders = Object.keys(ENROLLED).flatMap((rel) => {
      const raw = fs.readFileSync(path.join(SRC, rel), 'utf8');
      return findHardcodedKindLabel(rel, raw).map((line) => `${rel}:${line}`);
    });
    expect(offenders).toEqual([]);
  });

  it('the allowlist stays empty, and its lowercase-prose reason is recorded', () => {
    // An allowlist that can grow silently is a second unenrolment channel.
    expect(Object.keys(ALLOWED_RETIRED_WORDING)).toEqual([]);
    expect(ALLOWED_LOWERCASE_PROSE).toContain('not the kind name');
  });

  it('every enrolled entry names a file that exists, with a reason', () => {
    for (const [rel, reason] of Object.entries(ENROLLED)) {
      expect(fs.existsSync(path.join(SRC, rel))).toBe(true);
      expect(reason.length).toBeGreaterThan(10);
    }
  });

  /**
   * 🔴 THE DELIBERATE NON-ENROLMENTS ARE ASSERTED, NOT ASSUMED. A file that is simply
   * missing from {@link ENROLLED} and a file that is missing ON PURPOSE look identical
   * from here, and the second one needs a reason on the record — otherwise "just add it
   * to ENROLLED" is the obvious-looking fix for a red that should never happen.
   *
   * The claim: each of these files exists, is scanned, and holds NO kind label at all —
   * neither a hardcoded one nor an import of the source module. A surface that starts
   * rendering the kind again fails here and has to make a decision.
   */
  it('🔴 the deliberately-unenrolled surfaces render NO kind label at all', () => {
    const rels = SCANNED.map((s) => s.rel);
    for (const [rel, reason] of Object.entries(DELIBERATELY_UNENROLLED)) {
      expect(reason.length).toBeGreaterThan(10);
      expect(rel in ENROLLED, `${rel} is in BOTH lists — pick one`).toBe(false);
      expect(rels, `${rel} is no longer scanned`).toContain(rel);
      const raw = fs.readFileSync(path.join(SRC, rel), 'utf8');
      expect(findHardcodedKindLabel(rel, raw), `${rel}: ${reason}`).toEqual([]);
      expect(findRetiredWording(rel, raw), `${rel}: ${reason}`).toEqual([]);
      expect(
        importsLabelSource(rel, raw),
        `${rel} imports the kind-label source again. ${reason} — if it now renders a ` +
          `kind, move it to ENROLLED and delete its entry here; if the import is dead, ` +
          `remove the import.`
      ).toBe(false);
    }
  });
});

describe('🔒 the label constants, pinned as WHOLE normalised strings', () => {
  /**
   * 🔴 PINNED LITERALLY, NOT DERIVED. Writing `expect(listingKindLabel('offsite'))
   * .toBe(LISTING_KIND_LABELS.offsite)` would pass for every possible value of the
   * constant — it asserts the implementation against itself. These are the words as
   * a human reads them, typed out.
   */
  it('the kind labels are exactly these words', () => {
    expect(LISTING_KIND_LABELS).toEqual({ onsite: 'Embedded', offsite: 'Standalone' });
    expect(LISTING_KIND_APP_LABELS).toEqual({
      onsite: 'Embedded app',
      offsite: 'Standalone app',
    });
    expect(STANDALONE_KIND_LABEL).toBe('Standalone');
    expect(EMBEDDED_KIND_LABEL).toBe('Embedded');
    expect(listingKindLabel('offsite')).toBe('Standalone');
    expect(listingKindLabel('onsite')).toBe('Embedded');
    expect(listingKindAppLabel('offsite')).toBe('Standalone app');
    expect(listingKindAppLabel('onsite')).toBe('Embedded app');
  });

  /**
   * 🔴 THE DEFERRAL WAS LIFTED ON PURPOSE — AND THIS TEST IS THE INVERSE OF WHAT IT
   * USED TO BE.
   *
   * It previously read `expect(LISTING_KIND_LABELS.onsite).not.toContain('Embedded')`,
   * pinning a decision to DEFER the "On-site" → "Embedded" rename because "Embedded"
   * reads close to "Embedding" (`ModelType.TextualInversion`) in `AppSettingsModal`.
   * That deferral is reversed by an explicit product decision, so the assertion is
   * inverted rather than deleted: the rename stays a recorded DECISION in both
   * directions, and a future revert to "On-site" fails HERE with this comment attached
   * instead of reading as ordinary copy drift.
   *
   * 🔴 THE COLLISION SURVIVES, AND ITS MITIGATION IS PINNED TOO. `'Embedding'` is NOT
   * renamed — it names a real model type with its own public vocabulary — so the rule
   * is that a kind label rendered near a model-type list uses the `… app` form, whose
   * noun disambiguates. That is why `LISTING_KIND_APP_LABELS.onsite` must keep the
   * suffix rather than collapsing to the bare word.
   */
  it('🔴 the on-site label WAS reworded to "Embedded" — a decision, not drift', () => {
    expect(LISTING_KIND_LABELS.onsite).toBe('Embedded');
    expect(LISTING_KIND_LABELS.onsite).toContain('Embedded');
    expect(LISTING_KIND_APP_LABELS.onsite).toContain('Embedded');
    // The retired word is GONE from both forms — the half a rename most often forgets.
    expect(LISTING_KIND_LABELS.onsite).not.toContain('On-site');
    expect(LISTING_KIND_APP_LABELS.onsite).not.toContain('On-site');
    // …and the disambiguating noun survives, because the `Embedding` collision does.
    expect(LISTING_KIND_APP_LABELS.onsite).toBe('Embedded app');
    // The model-type label it collides with is NOT this module's to rename, and the
    // guard above must not match it: `\bEmbedded\b` is not `Embedding`.
    expect(KIND_LABEL_WORD.test('Embedding')).toBe(false);
    expect(KIND_LABEL_WORD.test('Embedded')).toBe(true);
  });

  it('every kind in the closed set has a label (no kind can render undefined)', () => {
    for (const kind of STORE_LISTING_KINDS) {
      expect(typeof listingKindLabel(kind)).toBe('string');
      expect(listingKindLabel(kind).length).toBeGreaterThan(0);
      expect(typeof listingKindAppLabel(kind)).toBe('string');
      expect(listingKindAppLabel(kind).length).toBeGreaterThan(0);
    }
  });
});

/**
 * 🔴 RULE (4): THE COPY CHANGE DID NOT TOUCH ANY VALUE.
 *
 * Every assertion here pins a string that crosses a boundary this UI does not own —
 * a database column, a public REST enum, a compile-time union's runtime source, a
 * Flipt key. If a future "let's finish the rename" commit reaches any of them, it
 * fails here rather than in a consumer's integration.
 */
describe('🔴 no ENUM / UNION / FLAG KEY / API contract value was renamed', () => {
  it('the stored kind values are still `onsite` / `offsite`', () => {
    expect(STORE_LISTING_KINDS).toEqual(['onsite', 'offsite']);
    expect([...STORE_LISTING_KINDS]).not.toContain('standalone');
  });

  it('the public /api/v1/apps kind filter still accepts all|onsite|offsite', () => {
    expect(listingKindFilterSchema.options).toEqual(['all', 'onsite', 'offsite']);
    expect(listingKindFilterSchema.parse('offsite')).toBe('offsite');
    expect(listingKindFilterSchema.parse('onsite')).toBe('onsite');
    // A renamed value would be REJECTED by the contract, which is the point.
    expect(listingKindFilterSchema.safeParse('standalone').success).toBe(false);
  });

  it('the visibility scope is still `public-external`', () => {
    expect(STORE_VISIBILITY_SCOPES).toEqual(['full', 'public-external', 'none']);
  });

  it('the Flipt flag key is still `app-listings-public-external`', () => {
    expect(APP_LISTINGS_PUBLIC_EXTERNAL_FLAG).toBe('app-listings-public-external');
  });

  it('the mode id in the submit page is still `external`, not the display word', () => {
    // The wizard's mode union and every `mode === 'external'` branch key on the ID.
    const raw = fs.readFileSync(path.join(SRC, 'components/Apps/SubmitModeSelector.tsx'), 'utf8');
    expect(raw).toContain("export type SubmitMode = 'block' | 'external'");
    expect(raw).toContain("onSelect('external')");
    expect(raw).toContain("onSelect('block')");
  });
});
