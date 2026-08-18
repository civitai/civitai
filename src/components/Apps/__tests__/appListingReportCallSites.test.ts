import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * 🔒 THE CALL-SITE LEDGER for the listing REPORT affordance.
 *
 * WHY THIS FILE EXISTS — measured, not hypothetical. `ReportListingModal` accepts an
 * `onReported` callback so its trigger can go spent once a report lands; the server
 * keeps at most ONE open report per reporter, so a second submission comes back as a
 * CONFLICT and the user sees an error where they expect a confirmation. The guard was
 * written — and lived in a standalone `ReportListingButton` that NOTHING rendered.
 * The live listing-detail page mounted the modal itself, passed no `onReported`, and
 * left its `⋮` menu item permanently clickable. Every existing test was green: the
 * button's own suite drove the dead component, and the detail page's suite only ever
 * asserted that the menu item OPENS the modal.
 *
 * So this pins the RELATIONSHIP rather than either component: the exact set of sites
 * that mount the report modal or render its trigger, that each mount is wired to the
 * spent-state callback, and that each trigger takes its disabled state and its label
 * FROM that state rather than hardcoding them. It fails when the ledger GROWS (a new
 * report surface that forgot the wiring) and when it SHRINKS (a site that dropped it,
 * or a testid rename that makes a trigger invisible to this check).
 *
 * 🔴 A STRUCTURAL CHECK IS NOT A BEHAVIOURAL ONE. This proves each site receives the
 * wiring; it cannot prove the wiring does the right thing at runtime. That claim is
 * made by two other suites, and this file deliberately does not replace them:
 *   - `AppListingDetailBody.browser.test.tsx` — reports through the REAL `⋮` menu and
 *     asserts the item comes back `disabled` + reading "Reported" (browser project).
 *   - `__tests__/appListingReportView.test.ts` — the pure `reportTriggerState` rule.
 *
 * 🔴 AND THE SCOPE THAT MATTERS IN CI: the browser `component` suite is REPORT-ONLY
 * (it always exits 0, is not a required check, and is not published at all when the
 * preview deploy fails). This unit-project ledger BLOCKS. So in CI the live path's
 * wiring is pinned structurally, by this file, and behaviourally only by a suite that
 * cannot fail a build.
 *
 * 🔴 KNOWN LIMITS, stated rather than implied:
 *   1. Detection is per-FILE and syntactic. A site that mounts the modal through an
 *      indirection (a wrapper component, a `React.createElement` call, a renamed
 *      import) is invisible here — the ledger would silently SHRINK, which the EXACT
 *      set assertion catches, but a wrapper ADDED beside an existing correct site
 *      would not be seen at all.
 *   2. Test files are excluded (they legitimately mount the modal bare, with no
 *      trigger, to exercise the form) — so this makes no claim about them.
 */

const SRC = path.resolve(__dirname, '../../..');

/** Path (relative to `src/`) of the modal component itself — never a call site. */
const MODAL_MODULE = 'components/Apps/ReportListingModal.tsx';

/**
 * Every PRODUCTION site that mounts `ReportListingModal`. One today: the listing
 * detail body, which is the live store surface. Adding a second report surface means
 * adding it here — that is the point, not an inconvenience.
 */
const MODAL_MOUNT_SITES = ['components/Apps/AppListingDetailBody.tsx'] as const;

/**
 * Every PRODUCTION site that renders the report TRIGGER, identified by the stable
 * `data-testid` the existing browser tests already select on. Same ledger discipline:
 * a rename shows up here as a SHRINK, not as a silent hole.
 */
const TRIGGER_TEST_ID = 'apps-listing-report-action';
const TRIGGER_SITES = ['components/Apps/AppListingDetailBody.tsx'] as const;

type MountSite = { file: string; onReportedWired: boolean };
type TriggerSite = { file: string; disabledFromState: boolean; labelFromState: boolean };

function parseTsx(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function attributeNames(node: ts.JsxOpeningLikeElement): string[] {
  return node.attributes.properties
    .filter(ts.isJsxAttribute)
    .map((attr) => attr.name.getText(node.getSourceFile()));
}

/** Does this element spread a bag whose property name is `prop` (e.g. `{...x.modalProps}`)? */
function spreadsProp(node: ts.JsxOpeningLikeElement, prop: string): boolean {
  return node.attributes.properties.some(
    (attr) =>
      ts.isJsxSpreadAttribute(attr) &&
      ts.isPropertyAccessExpression(attr.expression) &&
      attr.expression.name.getText(node.getSourceFile()) === prop
  );
}

function stringAttribute(node: ts.JsxOpeningLikeElement, name: string): string | null {
  for (const attr of node.attributes.properties) {
    if (!ts.isJsxAttribute(attr)) continue;
    if (attr.name.getText(node.getSourceFile()) !== name) continue;
    const init = attr.initializer;
    if (init && ts.isStringLiteral(init)) return init.text;
  }
  return null;
}

/**
 * Are this element's children a live EXPRESSION rather than literal text? That is what
 * separates `{report.label}` (reads "Reported" once spent) from a hardcoded `Report`,
 * which is the mutant a `disabled`-only check would sail past.
 */
function childrenAreExpression(node: ts.JsxOpeningLikeElement): boolean {
  const parent = node.parent;
  if (!ts.isJsxElement(parent)) return false;
  const meaningful = parent.children.filter(
    (child) => !(ts.isJsxText(child) && child.getText(parent.getSourceFile()).trim() === '')
  );
  return (
    meaningful.length > 0 &&
    meaningful.every((child) => ts.isJsxExpression(child) && !!child.expression)
  );
}

/** Analyse ONE source text. Exported shape is what the fixtures below assert against. */
function analyze(fileName: string, text: string): { mounts: MountSite[]; triggers: TriggerSite[] } {
  const sf = parseTsx(fileName, text);
  const mounts: MountSite[] = [];
  const triggers: TriggerSite[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf);
      const attrs = attributeNames(node);

      if (tag === 'ReportListingModal') {
        mounts.push({
          file: fileName,
          onReportedWired: attrs.includes('onReported') || spreadsProp(node, 'modalProps'),
        });
      }

      if (stringAttribute(node, 'data-testid') === TRIGGER_TEST_ID) {
        triggers.push({
          file: fileName,
          disabledFromState: attrs.includes('disabled') || spreadsProp(node, 'triggerProps'),
          labelFromState: childrenAreExpression(node),
        });
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);

  return { mounts, triggers };
}

/** Every non-test `.tsx` under `src/`, relative to `src/`. */
function productionTsxFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.tsx')) continue;
      if (entry.name.includes('.test.')) continue;
      out.push(path.relative(SRC, full).split(path.sep).join('/'));
    }
  };
  walk(SRC);
  return out.sort();
}

const scanned = productionTsxFiles().map((file) => ({
  file,
  ...analyze(file, fs.readFileSync(path.join(SRC, file), 'utf8')),
}));

describe('report affordance call-site ledger', () => {
  it('the instrument can SEE a site at all (positive control)', () => {
    // A reassuring zero from a scanner nobody has watched find something is
    // indistinguishable from a scanner wired to nothing.
    expect(scanned.length).toBeGreaterThan(500);
    expect(scanned.some((f) => f.file === MODAL_MOUNT_SITES[0])).toBe(true);
    expect(scanned.flatMap((f) => f.mounts).length).toBeGreaterThan(0);
    expect(scanned.flatMap((f) => f.triggers).length).toBeGreaterThan(0);
  });

  it('the EXACT set of modal mount sites is the ledger (fails on GROW or SHRINK)', () => {
    const found = scanned
      .filter((f) => f.mounts.length > 0 && f.file !== MODAL_MODULE)
      .map((f) => f.file);
    expect(found).toEqual([...MODAL_MOUNT_SITES]);
  });

  it('the EXACT set of trigger sites is the ledger (fails on GROW, SHRINK or testid rename)', () => {
    const found = scanned.filter((f) => f.triggers.length > 0).map((f) => f.file);
    expect(found).toEqual([...TRIGGER_SITES]);
  });

  it('🔴 EVERY modal mount is wired to the spent-state callback', () => {
    // THE REGRESSION. Pre-fix, `AppListingDetailBody` mounted the modal with
    // `opened` / `onClose` only, so a successful report left its menu item live and
    // the next click returned the server's one-open-report-per-reporter CONFLICT.
    const unwired = scanned
      .flatMap((f) => f.mounts.map((m) => ({ ...m, file: f.file })))
      .filter((m) => m.file !== MODAL_MODULE && !m.onReportedWired)
      .map((m) => m.file);
    expect(unwired).toEqual([]);
  });

  it('🔴 EVERY trigger takes BOTH its disabled state and its label from that state', () => {
    const triggers = scanned.flatMap((f) => f.triggers.map((t) => ({ ...t, file: f.file })));
    expect(triggers.filter((t) => !t.disabledFromState).map((t) => t.file)).toEqual([]);
    expect(triggers.filter((t) => !t.labelFromState).map((t) => t.file)).toEqual([]);
  });
});

describe('the ledger analyser itself (negative controls)', () => {
  // Realistic fixtures, in the two shapes that actually shipped — not textbook ones.
  const PRE_FIX = `
    export function Body() {
      return (
        <>
          <Menu.Item onClick={reportModal.open} data-testid="${TRIGGER_TEST_ID}">
            Report
          </Menu.Item>
          <ReportListingModal appListingId={detail.id} opened={reportOpened} onClose={reportModal.close} />
        </>
      );
    }
  `;
  const FIXED = `
    export function Body() {
      return (
        <>
          <Menu.Item {...report.triggerProps} data-testid="${TRIGGER_TEST_ID}">
            {report.label}
          </Menu.Item>
          <ReportListingModal appListingId={detail.id} {...report.modalProps} />
        </>
      );
    }
  `;

  it('flags the pre-fix shape (unwired mount, hardcoded live trigger)', () => {
    const { mounts, triggers } = analyze('probe.tsx', PRE_FIX);
    expect(mounts).toHaveLength(1);
    expect(mounts[0].onReportedWired).toBe(false);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].disabledFromState).toBe(false);
    expect(triggers[0].labelFromState).toBe(false);
  });

  it('passes the fixed shape', () => {
    const { mounts, triggers } = analyze('probe.tsx', FIXED);
    expect(mounts[0].onReportedWired).toBe(true);
    expect(triggers[0].disabledFromState).toBe(true);
    expect(triggers[0].labelFromState).toBe(true);
  });

  it('accepts an explicit `onReported` / `disabled` too, not only the prop bags', () => {
    const explicit = `
      <>
        <Menu.Item disabled={reported} onClick={open} data-testid="${TRIGGER_TEST_ID}">
          {label}
        </Menu.Item>
        <ReportListingModal appListingId={id} opened={opened} onClose={close} onReported={mark} />
      </>
    `;
    const { mounts, triggers } = analyze('probe.tsx', explicit);
    expect(mounts[0].onReportedWired).toBe(true);
    expect(triggers[0].disabledFromState).toBe(true);
    expect(triggers[0].labelFromState).toBe(true);
  });

  it('a spread of some OTHER bag does not count as wiring', () => {
    const wrong = `
      <>
        <Menu.Item {...someOtherProps} data-testid="${TRIGGER_TEST_ID}">{label}</Menu.Item>
        <ReportListingModal appListingId={id} {...someOtherProps} />
      </>
    `;
    const { mounts, triggers } = analyze('probe.tsx', wrong);
    expect(mounts[0].onReportedWired).toBe(false);
    expect(triggers[0].disabledFromState).toBe(false);
  });
});
