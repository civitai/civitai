import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { stripComments } from '../../../../test/strip-comments';

/**
 * SOURCE GATE — the sub nav's tab row must stay horizontally scrollable at EVERY width.
 *
 * This is the cheap half of a pair. It fails in ~0.3s and names the CAUSE (a class), which the
 * geometry test beside it cannot. `HomeTabs.geometry.test.tsx` asserts the CONSEQUENCE in a real
 * browser with the real cascade and is immune to how the classes are spelled. Keep both; if only
 * one can survive, keep the geometry one.
 *
 * WHY. The row is content-width and never collapses: `useResolvedNav` derives the bar/More split
 * from the user's saved config, not the viewport, so the row is a fixed ~1334px signed in
 * (measured 2026-09-15) at every width from 1024 to 1400. It used to carry
 * `@md:overflow-visible`, which overrode
 * BOTH axes above the `md` container breakpoint (1024px) and removed the row's only escape.
 * Measured 2026-09-14 at 1136px signed in: right edge 1334, scrollable overflow 0, and neither
 * "Shop" nor "More" hit-testable, on every route. `document.scrollWidth` stayed equal to the
 * viewport throughout — an ancestor `overflow-hidden` absorbs it — so a page-level overflow check
 * cannot see this bug.
 *
 * WHY THE PADDING IS PART OF THE SAME DECISION. `overflow-y` cannot be `visible` while
 * `overflow-x` is `auto` (CSS Overflow 3: it computes to `auto`), so a horizontally scrollable row
 * necessarily clips on both axes. Mantine's focus ring is `outline: 2px` at `outline-offset: 2px`
 * — 4px of ink OUTSIDE the border box on all four sides — and an outline contributes no scrollable
 * overflow, so a clipped ring cannot be scrolled into view. Measured at 1136: without horizontal
 * padding the first pill's ring fell 4px outside the clip box on the left and the More button's
 * 4px outside on the right. Hence horizontal padding, sized from the ink rather than from the 2px
 * of slack a 32px pill happens to have in its row.
 *
 * NOT `TwScrollX`, the repo's shared scrollable strip that covers six other rows. Its outer
 * wrapper is `relative overflow-hidden` (`TwScrollX.tsx:43`) — exactly the pair the ⚠️ below
 * forbids — so it would not merely overlay this row's controls, it would DELETE the More
 * dropdown at every width, and that is not fixable without changing `TwScrollX` for all six of
 * its consumers. Secondarily it paints a scroll arrow at `absolute inset-y-0 right-0 z-10` with
 * no prop to suppress it, over the More trigger this fix exists to make clickable, and hardcodes
 * `scrollbar-none`. (An earlier version of this paragraph also said it "pays no padding" — that
 * is wrong, `className` reaches its inner scroller.)
 *
 * ⚠️ DO NOT GIVE THIS ROW `relative`, `position: sticky`, `@container`, a `transform`, a `filter`,
 * or `will-change`. (Only this row — a position on `SubNav2` above it moves the dropdown's
 * containing block further OUT, not in, so it is not part of the invariant. An `overflow` clip
 * there would be, and nothing checks that.)
 * The More menu's dropdown is not portalled (the theme defaults `Popover.withinPortal` to false and
 * Mantine's `Menu` does not override it), so it renders inside this row and escapes the clip only
 * because it is absolutely positioned and its containing block is the sticky subnav ABOVE the
 * scroller. Any of those makes the clipping box its containing block instead, and the menu
 * disappears at every width.
 *
 * Measured 2026-09-15, wrapping the More button in a `position: sticky` element: the dropdown's
 * rect was IDENTICAL with and without the fault — same x, y, width, height — while its item went
 * from `hitTestable: true` to `false`. A rect assertion and a `textContent` assertion both pass
 * against the broken state. Only hit-testing separates them, which is why the geometry file beside
 * this one opens the menu and hit-tests an item — see the test named for this trap. Measured:
 * before that test existed, planting `relative` on the row passed both tiers green.
 *
 * TO WHOEVER IS ABOUT TO DELETE THIS: re-adding any width-conditional override of this row's
 * overflow puts the tabs back out of reach between 1024px and ~1342px — roughly a third of desktop
 * widths, on every route. If the row should collapse by width instead, that reverses PR #4591's
 * deliberate removal of width-driven placement and is a product decision, not a CSS one.
 */

const COMPONENT = path.resolve(__dirname, '../HomeContentToggle.tsx');

/** The row wrapping the nav pills — matched on the pair of classes only it carries. */
const ROW = /<div\s+className="([^"]*\bgap-1\b[^"]*\boverflow-x-auto\b[^"]*)"/g;

function tabRowClassName(source: string): string {
  const matches = [...source.matchAll(ROW)];
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one tab row in HomeContentToggle.tsx, found ${matches.length}. If the row ` +
        'was refactored or a second scroller was added above it, re-point this guard rather than ' +
        'deleting it — see the block comment above.'
    );
  }
  return matches[0][1];
}

describe('sub nav tab row', () => {
  // Comments stripped first: without this, deleting the live element and leaving a commented-out
  // copy leaves exactly one match, and every assertion below passes against a component that no
  // longer renders the row. Strings are KEPT — `className` is one.
  const source = stripComments(readFileSync(COMPONENT, 'utf8'));

  it('scrolls horizontally with no width-conditional overflow override', () => {
    const className = tabRowClassName(source);

    expect(className).toContain('overflow-x-auto');
    // Whitelist the tokens rather than enumerate variant prefixes. A pattern like
    // /@(max-)?\w+:overflow-/ sees only CONTAINER variants, so the viewport spelling
    // `md:overflow-visible` — which switches at the same 1024px, since `screens` and `containers`
    // both come from breakpoints.json — restores the identical dead band and passes.
    //
    // Match `overflow` anywhere in the token, not the substring `overflow-`: the arbitrary-property
    // spelling `lg:[overflow:visible]` contains no hyphen after the word and would otherwise be
    // invisible here. Sorted, because the pair's order carries no meaning.
    const overflow = className.split(/\s+/).filter((token) => /overflow/.test(token));
    expect(overflow.sort()).toEqual(['overflow-x-auto', 'overflow-y-hidden']);
  });

  it('can shrink below its content width so the feed filters stay on one line', () => {
    // `SubNav2` wraps, and a wrapping container places items at their flex BASIS before it shrinks
    // anything — so at `basis: auto` this row's content width pushes the filters to a second line.
    // Justin asked for one line (2026-09-15). The geometry file beside this one measures the
    // consequence and reddens by a whole line height when this token goes; this tier names it.
    expect(tabRowClassName(source).split(/\s+/)).toContain('flex-1');
  });

  it('carries nothing that would become the containing block of the More dropdown', () => {
    // The ⚠️ above, as a check rather than as prose. The geometry file beside this one catches the
    // same fault by hit-testing an open menu; this tier names the cause in 0.3s.
    //
    // A WHITELIST, for the same reason the overflow assertion above is one, and this was a denylist
    // first: the set of ways to become a containing block is open-ended and a denylist leaked four
    // ways at once — `[position:relative]` survives any variant-prefix strip, `scale-95` /
    // `rotate-3` / `translate-x-1` emit a `transform` without the word in the token, `blur-sm` and
    // `grayscale` emit a `filter`, and `contain-layout` / `content-visibility-*` apply the same
    // layout containment that makes `@container` unsafe here. Enumerating what IS allowed closes
    // all four and makes every future token a deliberate decision.
    expect(tabRowClassName(source).split(/\s+/).sort()).toEqual([
      'dark:text-white',
      'flex',
      'flex-1',
      'gap-1',
      'items-center',
      'overflow-x-auto',
      'overflow-y-hidden',
      'px-[calc(0.125rem*var(--mantine-scale,1)+2px)]',
      'text-black',
    ]);
  });

  it('pays unconditional horizontal padding so the focus ring is not clipped on the scroll axis', () => {
    const className = tabRowClassName(source);
    const padding = className.split(/\s+/).filter((token) => /(^|:)-?p[xytrbl]?-/.test(token));

    // Unconditional: a `md:`/`@md:`-prefixed token leaves the row unpadded below the breakpoint.
    expect(padding.every((token) => !token.includes(':'))).toBe(true);
    // Nonzero on BOTH axes. `py-0` and `p-0` are the exact states this forbids, and both satisfy
    // a naive /\bp[xy]-\d/. Every side spelling counts, so `pt-1 pb-1 px-1` — behaviourally
    // identical to `p-1` — is accepted rather than rejected for being written out.
    const SIDES: Record<string, string[]> = {
      '': ['x', 'y'],
      x: ['x'],
      y: ['y'],
      t: ['y'],
      b: ['y'],
      l: ['x'],
      r: ['x'],
    };
    const axes = padding.flatMap((token) => {
      // An arbitrary value — the row ships a `px-[calc(…)]` — because the ring's ink
      // is part-px and part-rem and a pure-rem scale only matches it at a 16px root. Its magnitude
      // is the geometry test's job; all this tier can say is that it is not a zero literal.
      const arbitrary = /^p([xytrbl]?)-\[(.+)\]$/.exec(token);
      if (arbitrary) return /^0[a-z]*$/.test(arbitrary[2]) ? [] : SIDES[arbitrary[1]];
      const [, side, value] = /^p([xytrbl]?)-([0-9.]+)$/.exec(token) ?? [];
      return value && Number(value) > 0 ? SIDES[side] : [];
    });
    // X ONLY, on purpose — the why is on the row itself in `HomeContentToggle.tsx`. This is the
    // axis that scrolls, and an outline contributes no scrollable overflow, so a ring clipped here
    // cannot be reached at all.
    expect([...new Set(axes)]).toContain('x');
  });
});
