import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 EVERY MODAL THE `⋮` MENU OPENS MUST BE MOUNTED OUTSIDE `<Menu.Dropdown>`.
 *
 * A Mantine `Menu.Dropdown` UNMOUNTS when the menu closes, so a modal rendered as a
 * sibling of its own `Menu.Item` is destroyed by the very click meant to open it.
 * `AppListingDetailBody` states that rule in a 🔴 comment and obeys it for all four of
 * its modals.
 *
 * ## Why this file exists: the behavioural test that claims to pin it DOES NOT
 *
 * `AppListingDetailBody.browser.test.tsx` carries a test whose comment says it is the
 * assertion that the modals are mounted outside the menu. MEASURED on this change, it is
 * not: moving `<ReviewListingModal>` inside `<Menu.Dropdown>` — the exact defect the rule
 * forbids, and the exact placement that test's comment describes — left the whole browser
 * suite green at **86/86**. Moving the new `<MessageAppOwnerModal>` in there did the same.
 * Two mutants, neither caught, by a suite that reads as covering them.
 *
 * The reason is timing, not selector: Mantine keeps the dropdown's subtree mounted through
 * its close transition, and the modal is portalled and opens synchronously, so
 * `expect.element(...).toBeInTheDocument()` resolves inside that window and cannot tell the
 * two placements apart. That is a real property of the rendering, so no rewrite of the
 * assertion in the browser tier is obviously going to fix it — and the browser tier is
 * report-only in CI regardless.
 *
 * So the rule is pinned STRUCTURALLY, in the blocking node project, where it is exactly a
 * claim about where a tag appears in the source. That is a weaker kind of evidence than a
 * behavioural test and is labelled as such — but a structural guard that goes red is worth
 * more than a behavioural one that never can.
 *
 * ## What it does NOT see, stated rather than implied
 *
 * Detection is syntactic and single-file. A modal mounted through a wrapper component, or
 * a second `<Menu.Dropdown>` added to this file, is outside what the span extractor below
 * models — which is why the extractor asserts there is exactly ONE dropdown and throws
 * otherwise, instead of silently checking the first one.
 */

const SRC = path.resolve(__dirname, '../../..');
const BODY_MODULE = 'components/Apps/AppListingDetailBody.tsx';

/**
 * Every modal the detail body's overflow menu opens. All four, not just the two this
 * change adds: the rule is the same for all of them, and the two pre-existing ones were
 * the mutants measured above as uncaught.
 */
const MENU_MODALS = [
  'ReviewListingModal',
  'ReportListingModal',
  'MessageAppOwnerModal',
  'ListingTakedownModal',
] as const;

/** A `data-testid` known to live INSIDE the dropdown — the extractor's positive control. */
const ITEM_INSIDE_DROPDOWN = 'apps-listing-report-action';

function source(): string {
  return fs.readFileSync(path.join(SRC, BODY_MODULE), 'utf8');
}

/**
 * The `[start, end)` character span of the single `<Menu.Dropdown>…</Menu.Dropdown>`.
 *
 * Throws rather than guessing when the file gains a second dropdown or loses the one it
 * has: a span silently taken from the wrong element would make every assertion below pass
 * for the wrong reason, which is the failure mode this whole file exists to avoid.
 */
function dropdownSpan(code: string): [number, number] {
  const opens = [...code.matchAll(/<Menu\.Dropdown[\s>]/g)];
  const closes = [...code.matchAll(/<\/Menu\.Dropdown>/g)];
  if (opens.length !== 1 || closes.length !== 1) {
    throw new Error(
      `expected exactly one <Menu.Dropdown> in ${BODY_MODULE}, found ${opens.length} open / ` +
        `${closes.length} close — widen this extractor rather than deleting the guard`
    );
  }
  const start = opens[0].index;
  const end = closes[0].index + '</Menu.Dropdown>'.length;
  if (!(end > start)) throw new Error('the dropdown closes before it opens');
  return [start, end];
}

describe('the detail body mounts every menu-opened modal OUTSIDE Menu.Dropdown', () => {
  it('the span extractor really grabbed the dropdown (positive control)', () => {
    // Without this, a span that matched nothing useful would make every "is outside"
    // assertion below trivially true — the zero that is indistinguishable from a probe
    // wired to nothing.
    const code = source();
    const [start, end] = dropdownSpan(code);
    const inner = code.slice(start, end);
    expect(inner).toContain(ITEM_INSIDE_DROPDOWN);
    expect(inner.length).toBeGreaterThan(200);
  });

  for (const modal of MENU_MODALS) {
    it(`${modal} is mounted outside the dropdown`, () => {
      const code = source();
      const [start, end] = dropdownSpan(code);
      const mounts = [...code.matchAll(new RegExp(`<${modal}[\\s/>]`, 'g'))].map((m) => m.index);
      // Positive control per modal: it IS mounted in this file at all, so an "outside"
      // verdict is about placement and not about an absent component.
      expect(mounts.length).toBeGreaterThan(0);
      const inside = mounts.filter((at) => at >= start && at < end);
      expect(inside).toEqual([]);
    });
  }

  it('the placement detector fires on a modal moved INSIDE the dropdown', () => {
    // 🔴 The negative control, on synthetic source rather than by editing the real file:
    // the same extractor + the same predicate, over a body where the modal sits where the
    // rule forbids. Without it, the four green results above are a claim about the
    // detector's silence rather than about the file.
    const planted = [
      '<Menu.Dropdown>',
      `  <Menu.Item data-testid="${ITEM_INSIDE_DROPDOWN}">Report</Menu.Item>`,
      '  <ReviewListingModal appListingId={detail.id} />',
      '  x'.repeat(120),
      '</Menu.Dropdown>',
    ].join('\n');
    const [start, end] = dropdownSpan(planted);
    const at = planted.indexOf('<ReviewListingModal');
    expect(at).toBeGreaterThan(-1);
    expect(at >= start && at < end).toBe(true);

    // …and it does NOT fire when the same modal sits after the dropdown closes.
    const correct = planted.replace(
      '  <ReviewListingModal appListingId={detail.id} />\n',
      ''
    ).concat('\n<ReviewListingModal appListingId={detail.id} />');
    const [s2, e2] = dropdownSpan(correct);
    const at2 = correct.indexOf('<ReviewListingModal');
    expect(at2 >= s2 && at2 < e2).toBe(false);
  });
});
