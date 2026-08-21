import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
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
 * The retired wordings, as WHOLE PHRASES.
 *
 * 🔴 Deliberately NOT a bare `offsite` / `external`. `'offsite'` is a stored VALUE
 * (the Prisma column, the REST enum, the `StoreListingKind` union) and appears in
 * hundreds of legitimate places; a rule that matched it would either be allowlisted
 * into uselessness or would push someone into renaming the value to satisfy it —
 * which is the one outcome rule (4) exists to prevent. Every phrase below is
 * unambiguously prose: none of them is, or can be, a value.
 */
const RETIRED_WORDINGS: RegExp[] = [/external app/i, /off-site/i, /offsite app/i];

/**
 * The kind label as a human reads it. Capital-S `Standalone` as a whole word is the
 * kind's NAME; lowercase `standalone` is an ordinary English adverb/adjective and is
 * deliberately NOT matched — see ALLOWED_LOWERCASE_PROSE for why that distinction is
 * load-bearing rather than lazy.
 */
const KIND_LABEL_WORD = /\bStandalone\b/;

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
        return (
          <div>
            <Badge title="External App">On-site and external</Badge>
            <Text>This is an offsite app that opens elsewhere.</Text>
            <Alert label={'Off-Site destination'} />
          </div>
        );
      }`;
    const hits = findRetiredWording('bad.tsx', bad);
    // 'external app', 'off-site', 'External App', 'offsite app', 'Off-Site' = 5.
    // (The JSX text "On-site and external" is NOT a hit — "external" alone is not a
    // banned phrase, which is exactly the narrowness the rule needs to stay usable.)
    expect(hits).toHaveLength(5);
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
          </div>
        );
      }`;
    expect(findHardcodedKindLabel('bad.tsx', bad)).toHaveLength(4);
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
      return !raw.includes(LABEL_SOURCE_IMPORT);
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
});

describe('🔒 the label constants, pinned as WHOLE normalised strings', () => {
  /**
   * 🔴 PINNED LITERALLY, NOT DERIVED. Writing `expect(listingKindLabel('offsite'))
   * .toBe(LISTING_KIND_LABELS.offsite)` would pass for every possible value of the
   * constant — it asserts the implementation against itself. These are the words as
   * a human reads them, typed out.
   */
  it('the kind labels are exactly these words', () => {
    expect(LISTING_KIND_LABELS).toEqual({ onsite: 'On-site', offsite: 'Standalone' });
    expect(LISTING_KIND_APP_LABELS).toEqual({
      onsite: 'On-site app',
      offsite: 'Standalone app',
    });
    expect(STANDALONE_KIND_LABEL).toBe('Standalone');
    expect(listingKindLabel('offsite')).toBe('Standalone');
    expect(listingKindLabel('onsite')).toBe('On-site');
    expect(listingKindAppLabel('offsite')).toBe('Standalone app');
    expect(listingKindAppLabel('onsite')).toBe('On-site app');
  });

  /**
   * 🔴 "On-site" IS DELIBERATELY UNCHANGED. Renaming it to "Embedded" was considered
   * and deferred — "Embedded" collides with "Embedding" (TextualInversion) one panel
   * away in `AppSettingsModal`. This pins the deferral so it is a decision, not drift.
   */
  it('the on-site label was NOT reworded', () => {
    expect(LISTING_KIND_LABELS.onsite).toBe('On-site');
    expect(LISTING_KIND_LABELS.onsite).not.toContain('Embedded');
    expect(LISTING_KIND_APP_LABELS.onsite).not.toContain('Embedded');
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
