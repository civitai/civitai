import { MantineProvider, Skeleton, Text } from '@mantine/core';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { AppsBuildBodySkeleton } from '~/components/Apps/AppsBuildBodySkeleton';

/**
 * `/apps/build` — WHAT THE SERVER ACTUALLY EMITS FOR THE LOADING STATE.
 *
 * 🔴 THIS GUARD IS EARNED BY THE CHANGE THAT ADDED IT, not copied for symmetry. Before
 * clawgate #530 an author's server render was state B; it is now this skeleton for every author
 * WHOSE SUMMARY QUERY RUNS. (Not every author: one without `appBlocks` settles immediately and
 * still gets state B — the qualifier is the same one `AppsBuildBody` carries.) So any markup defect in it is a defect in production's SSR HTML,
 * and the two things most worth pinning are exactly the two the store skeleton shipped
 * broken and had to be corrected for (see `AppListingCardSkeleton.ssr.browser.test.tsx`,
 * whose header records both):
 *
 *   1. that the server emits a REAL skeleton rather than an empty shell — the store's
 *      first attempt seeded its cell count in a layout effect, which does not run during
 *      SSR, so it replaced a spinner with literally nothing;
 *   2. that no `<div>` descends from a `<p>`. Mantine's `Text` renders `<p>` and its
 *      `Skeleton` renders `<div>`, so the obvious spelling of a text-line bar is invalid
 *      HTML: a parser auto-closes the `<p>`, React's tree and the parsed DOM disagree, and
 *      every render is a hydration mismatch. `TextLineSkeleton` passes `component="span"`
 *      for that reason and this is what stops that becoming an unread comment.
 *
 * 🔴 `renderToString` IS THE INSTRUMENT BECAUSE IT RUNS NO EFFECTS — not `useEffect`, not
 * `useLayoutEffect` — so it reproduces the server's output faithfully even though this
 * suite runs in a browser where `window` exists.
 */

function serverHtml(node: React.ReactElement): string {
  return renderToString(<MantineProvider>{node}</MantineProvider>);
}

/**
 * Every `<div …>` appearing between a `<p …>` and its `</p>`.
 *
 * 🔴 A DELIBERATELY DUMB STRING SCAN, and it must stay one. Handing the markup to the
 * browser's parser would be useless: the parser is the thing that AUTO-CLOSES the `<p>`, so
 * the tree it returns has already silently repaired the offence. The defect lives in the
 * STRING. (Duplicated from the store skeleton's suite rather than shared — it is four lines
 * of scanner, and each copy carries its own positive control below, which is the thing that
 * actually keeps it honest.)
 */
function divsInsideParagraphs(html: string): number {
  let count = 0;
  const openP = /<p\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = openP.exec(html)) !== null) {
    const from = m.index + m[0].length;
    const close = html.indexOf('</p>', from);
    const segment = close === -1 ? html.slice(from) : html.slice(from, close);
    count += [...segment.matchAll(/<div\b/g)].length;
  }
  return count;
}

describe('AppsBuildBodySkeleton — the server render', () => {
  test('POSITIVE CONTROLS — the instrument renders, and the scanner can see a real offence', () => {
    // (a) `renderToString` produced markup at all. Without this, every assertion below is
    //     satisfied by the empty string.
    const html = serverHtml(<AppsBuildBodySkeleton />);
    expect(html.length, 'renderToString produced nothing').toBeGreaterThan(200);

    // (b) the scanner returns NON-ZERO on markup that genuinely nests a div in a p — the
    //     exact shape `TextLineSkeleton` would have if `component="span"` were dropped. A
    //     zero from a scanner that has never been watched go non-zero is not a measurement.
    const bad = serverHtml(
      <Text size="sm">
        {' '}
        <Skeleton style={{ position: 'absolute' }} />
      </Text>
    );
    expect(divsInsideParagraphs(bad), 'the scanner cannot see an invalid nesting').toBeGreaterThan(
      0
    );
  });

  test('🔴 the server emits a real skeleton, not an empty shell', () => {
    const html = serverHtml(<AppsBuildBodySkeleton />);
    expect(html).toContain('apps-build-skeleton');
    // The live region's announceable text — it is CONTENT, so it has to be in the markup
    // and not merely an aria-label. See the note in the component.
    expect(html).toContain('Loading your apps');
    // The reserved rows are rendered, not deferred to an effect that SSR never runs.
    expect([...html.matchAll(/mantine-Skeleton-root/g)].length).toBeGreaterThan(1);
  });

  /**
   * 🔴 THE A11Y CLAIM, ASSERTED RATHER THAN MERELY WRITTEN. The component's header claims "a
   * `role="status"` region, not marked busy, with non-hidden text". Both halves were prose
   * only until this test: the spec above asserts the testid, the sr-only string and the bar
   * count, none of which would notice `role` being dropped or `aria-busy` being added.
   *
   * `aria-busy="true"` on a live region is the standard instruction to WITHHOLD announcements
   * — and this region UNMOUNTS rather than clearing, so a busy flag here could never flip back
   * to false and the loading state would announce nothing at all, in markup whose own comment
   * claims it is the thing that announces. That exact defect shipped in the store skeleton.
   *
   * ⚠️ STILL NOT A SCREEN-READER TEST. It pins the two markup properties the claim rests on;
   * whether a particular AT announces this is untested here and is not asserted anywhere.
   */
  test('🔴 the live region is announceable: role="status" present, aria-busy absent', () => {
    const html = serverHtml(<AppsBuildBodySkeleton />);

    // 🔴 ORDER IS DELIBERATE: the FIRST assertion is the positive control for the SECOND.
    // `not.toContain` passes for free against an empty string or a scanner wired to nothing,
    // so on its own it would prove that `aria-busy` is absent from a document this test never
    // read. `role="status"` is an ATTRIBUTE on the SAME element, so a green first line is what
    // makes the absence assertions below observations. (The scoped checks use a regex rather
    // than `toContain`, and carry their own `not.toBeNull()` control on the match.)
    expect(html).toContain('role="status"');

    // 🔴 SCOPED TO THE LIVE REGION'S OWN TAG, NOT THE WHOLE DOCUMENT — and that is a
    // correction. A document-wide `expect(html).not.toContain('aria-busy')` makes a claim
    // far wider than the one the component states: it would go red if a Mantine bump ever
    // emitted `aria-busy` on a child `<Skeleton>`, which would not falsify "the live region
    // is not marked busy" at all. An over-strict guard fails on a change that is not a
    // defect, and gets deleted the first time it does.
    const region = html.match(/<[^>]*role="status"[^>]*>/);
    expect(region, 'no element carries role="status"').not.toBeNull();
    expect(region?.[0], 'the live region itself is marked busy').not.toContain('aria-busy');

    // 🔴 AND EVERY ANCESTOR — WITHOUT THIS THE NARROWING ABOVE BLINDS THE GUARD. MEASURED:
    // wrapping the component in `<div aria-busy="true">` SURVIVES the scoped assertion alone
    // (4 passed) and dies here. Everything before the region's opening tag is its ancestors
    // and their preceding siblings AND those siblings' whole subtrees — over-broad by exactly
    // that, which is the right direction to err for a suppression check. (An earlier draft
    // said "by exactly the siblings", which understated it: the slice is raw markup, so a
    // sibling's descendants are inside it too.)
    //
    // ⚠️ SCOPE, STATED SO IT IS NOT OVER-READ: this spec renders `AppsBuildBodySkeleton`
    // ALONE, so "every ancestor" means every ancestor INSIDE this component. A busy ancestor
    // contributed by the page layout or `AppsPageLayout` is out of this test's reach and is
    // guarded nowhere.
    //
    // ⚠️ WHY AN ANCESTOR IS WORTH GUARDING IS NOT A CLAIM I HAVE VERIFIED, AND AN EARLIER
    // DRAFT OF THIS COMMENT ASSERTED IT AS FACT ("ARIA treats `aria-busy` on an element
    // containing a live region as the same instruction to withhold its announcements"). That
    // may well be right, but I checked it against neither the spec nor a screen reader, and
    // this file has already been through two rounds of replacing one confident sentence with
    // a differently wrong one. So the honest justification is the narrow one: the
    // document-wide form this replaced DID cover the ancestor case, the narrowing dropped it
    // for a reason that only argued about DESCENDANTS, and a dropped case is not something to
    // re-derive a purpose for. If someone establishes that a busy ancestor cannot suppress
    // this region, delete this assertion — do not reword it.
    //
    // 🔴 THE LESSON, BECAUSE IT COST A ROUND: when you NARROW a guard, mutate the case you
    // just EXCLUDED, not the case you kept. The previous round re-ran the region mutation,
    // watched it still die, and called the narrowing safe — it had only re-tested the half
    // that was never at risk.
    // 🔴 THIS ASSERTION NEEDS ITS OWN POSITIVE CONTROL, AND THE `role="status"` LINE ABOVE IS
    // NOT IT. That line proves the DOCUMENT is non-empty; it says nothing about the SLICE. If
    // `region.index` were ever 0 the slice is `''` and `not.toContain` passes for free — the
    // precise vacuous-absence hazard the comment above warns about, reintroduced one assertion
    // later. Measured today: `region.index` is 882 and the slice holds MantineProvider's
    // `<style data-mantine-styles>` preamble, so it is non-vacuous — but nothing would say so
    // if Mantine stopped emitting that.
    const beforeRegion = html.slice(0, region?.index ?? 0);
    expect(
      beforeRegion.length,
      'the ancestor slice is empty — the assertion below is vacuous'
    ).toBeGreaterThan(0);
    expect(
      beforeRegion,
      'an ANCESTOR of the live region is marked busy, which suppresses it'
    ).not.toContain('aria-busy');
  });

  test('🔴 no <div> descends from a <p> — the hydration-mismatch shape', () => {
    expect(divsInsideParagraphs(serverHtml(<AppsBuildBodySkeleton />))).toBe(0);
  });
});
