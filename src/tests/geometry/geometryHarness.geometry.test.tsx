/**
 * THE HARNESS'S OWN POSITIVE CONTROLS.
 *
 * 🔴 EVERY OTHER FILE IN THIS PROJECT IS A CLAIM ABOUT PIXELS, AND A PIXEL CLAIM
 * IS ONLY WORTH THE CASCADE IT WAS MEASURED AGAINST. A harness that silently
 * loaded nothing would compute `0` for every gap and `block` for every flex
 * container, and a suite written against it would pass while observing nothing —
 * which is precisely the failure in the `component` tier that this project
 * exists to close. So the things the harness advertises are asserted here as
 * non-zero COUNTS and as RESOLVED VALUES that cannot exist without the
 * stylesheet that produces them.
 *
 * These are controls, not coverage: they are expected to be green forever, and
 * the moment one goes red every geometry number in this project is void.
 */
import { Button, Group } from '@mantine/core';
import { describe, expect, test } from 'vitest';
import {
  NARROW_PHONE_VIEWPORT,
  PHONE_VIEWPORT,
  box,
  cascadeEvidence,
  childrenUnionBox,
  flexAxis,
  flexLonghands,
  loadedCssRuleCount,
  observedViewport,
  renderAtViewport,
} from '../../../test/geometry-setup';

describe('geometry harness — positive controls', () => {
  /**
   * 🔴 THE VIEWPORT IS OBSERVED, NOT TRUSTED.
   *
   * The runner's DEFAULT is 414x896 — measured against this repo's pinned Vitest
   * 4.1.11 / Playwright provider on 2026-09-03. It is a default, not "unset", and
   * that is the trap: a suite that never calls `page.viewport()` is measuring
   * 414px and does not say so, and the number belongs to the runner rather than
   * to anything in this repo, so a Vitest bump can move it with nothing to
   * notice. Both directions are asserted here — the requested size is observed,
   * AND it is not the default it would have inherited.
   */
  test('the phone viewport this harness sets is the one the window reports', async () => {
    const { observed } = await renderAtViewport(<div data-testid="probe">probe</div>);

    expect(
      observed,
      'the window did not report the viewport the harness asked for, so every measurement in ' +
        'this project is about a screen nobody chose'
    ).toEqual({ width: 390, height: 844 });

    expect(observed).toEqual({ width: PHONE_VIEWPORT.width, height: PHONE_VIEWPORT.height });

    // NEGATIVE HALF: 414x896 is what an unset viewport would have given, so a
    // `page.viewport` call that silently did nothing lands exactly here.
    expect(
      observed.width,
      'the observed width is the runner default (414), i.e. `page.viewport` did not take effect'
    ).not.toBe(414);
  });

  test('a SECOND, narrower viewport is also observed — the setting is not a one-off', async () => {
    // One measurement is not a general claim: two points, a boundary and a
    // middle of the phone band, so "the harness can set a viewport" is not
    // resting on the single value the default happens not to equal.
    const { observed } = await renderAtViewport(<div>probe</div>, NARROW_PHONE_VIEWPORT);
    expect(observed).toEqual({ width: 360, height: 780 });
    expect(observedViewport()).toEqual({ width: 360, height: 780 });
  });

  /**
   * 🔴 THE CASCADE IS LOADED — one non-zero count and three resolved values, each
   * measured in BOTH tiers and kept only because the two disagree.
   *
   *                             `component`      `geometry`
   *   CSS rules                          24           3,677
   *   box-sizing on a bare div  content-box      border-box
   *   `className="flex"`              block            flex
   *
   * The rule-count floor sits between those two numbers with a wide margin on
   * each side, so it catches "wired to nothing" without becoming a gate that
   * churns on a Mantine or Tailwind version bump.
   */
  test('the REAL app cascade is loaded and applied', async () => {
    await renderAtViewport(<div>probe</div>);
    const evidence = cascadeEvidence();

    expect(
      evidence.ruleCount,
      `the document holds only ${evidence.ruleCount} CSS rules — the app cascade did not load, ` +
        'and every geometry assertion in this project is measuring an unstyled document'
    ).toBeGreaterThan(500);

    // Tailwind preflight's `*, ::before, ::after { box-sizing: border-box }`. The
    // UA default is `content-box`, which is what the `component` tier reports.
    expect(evidence.probeBoxSizing).toBe('border-box');

    // 🔴 `@tailwind utilities`. THE `component` TIER LOADS NONE OF IT, so a
    // `className="flex"` computes `display: block` there. This repo's shell
    // layout is Tailwind-heavy, which is why a whole layer of it is
    // unexpressible in that tier and expressible here.
    expect(
      evidence.tailwindFlexUtilityResolves,
      'a `className="flex"` element does not compute `display: flex` — the Tailwind utility ' +
        'layer is missing, so any fixture built from the real shell classes is inert'
    ).toBe(true);

    // The `@layer` ORDER statement, and the invariant that actually matters: no
    // `@layer <name> { … }` block registered a layer name before it. The names
    // are compared verbatim against `src/pages/_document.tsx`'s production
    // string — a subset check would pass with a layer silently dropped.
    expect(
      evidence.layerOrder.declaredOrder,
      'the cascade-layer order statement is missing or does not match production — layer ' +
        'priority here is not the priority the app ships'
    ).toEqual(['tailwind-preflight', 'theme', 'mantine', 'modules']);
    expect(
      evidence.layerOrder.declaredBeforeAnyLayerBlock,
      'a layered stylesheet was parsed BEFORE the order statement, so layer priority is being ' +
        'decided by import order rather than by the declaration production uses'
    ).toBe(true);
  });

  /**
   * The Mantine half, measured off a REAL rendered component rather than out of
   * the CSSOM. `--mantine-*` custom properties are NOT a witness for this:
   * `MantineProvider` injects those at runtime, so they resolve in the
   * `component` tier too, which loads no Mantine stylesheet at all. What only the
   * stylesheet can produce is a Mantine CLASS having geometry.
   */
  test('Mantine component rules are loaded — a rendered Button has real geometry', async () => {
    const before = loadedCssRuleCount();
    expect(before).toBeGreaterThan(500);

    await renderAtViewport(
      <Button data-testid="mantine-button" size="sm">
        Go
      </Button>
    );
    const el = document.querySelector('[data-testid="mantine-button"]') as HTMLElement;
    const b = box(el);
    const padInlineStart = parseFloat(
      getComputedStyle(el).getPropertyValue('padding-inline-start')
    );

    expect(
      b.height,
      `a Mantine Button rendered ${b.height}px tall — with no Mantine stylesheet it is an ` +
        'unstyled inline element and every box measured in this project is meaningless'
    ).toBeGreaterThan(20);
    expect(padInlineStart).toBeGreaterThan(0);
  });

  /**
   * 🔴 THE AXIS AND THE LONGHANDS — the two facts the attribute tier cannot see,
   * and the pair a `flex: 1 1 <len>` defect lives in.
   *
   * A Mantine `Group` is a `row` by default; forcing `flexDirection: 'column'` is
   * a real shape in this repo (`ChromeSurfaceGroup` does exactly that). Under a
   * harness with no Mantine stylesheet `Group` is `display: block`, so `flexAxis`
   * returns `'none'` and neither arm below is observable.
   */
  test('a flex container reports its AXIS, and a child reports its LONGHANDS', async () => {
    await renderAtViewport(
      <>
        <Group data-testid="row-group">
          <div data-testid="row-child" style={{ flex: '1 1 220px' }}>
            child
          </div>
        </Group>
        <Group data-testid="col-group" style={{ flexDirection: 'column' }}>
          <div data-testid="col-child" style={{ flex: '1 1 220px' }}>
            child
          </div>
        </Group>
      </>
    );

    const rowGroup = document.querySelector('[data-testid="row-group"]') as HTMLElement;
    const colGroup = document.querySelector('[data-testid="col-group"]') as HTMLElement;

    expect(
      flexAxis(rowGroup),
      'a Mantine `Group` is not a flex row here — the Mantine stylesheet is not applied, so no ' +
        'axis-dependent claim in this project can be believed'
    ).toBe('row');
    expect(flexAxis(colGroup)).toBe('column');

    // The longhand survives the shorthand's serialisation. `getComputedStyle(el).flex`
    // renders `1 1 220px` and `1 1 0%` the same shape; `flex-basis` does not.
    const rowChild = document.querySelector('[data-testid="row-child"]') as HTMLElement;
    expect(flexLonghands(rowChild)).toEqual({ grow: '1', shrink: '1', basis: '220px' });
  });

  /**
   * `childrenUnionBox` is the measurement the whole defect class turns on — "how
   * much box does the content actually need", against which a parent's own box
   * can be compared. `scrollHeight` cannot answer it (it is clamped to the
   * padding box, so a parent far TALLER than its content reports its own
   * height), which is why the helper exists at all. Both halves are asserted:
   * the union is smaller than a deliberately-oversized parent, and `scrollHeight`
   * is shown to be blind to exactly that gap.
   */
  test('childrenUnionBox sees an oversized parent that scrollHeight cannot', async () => {
    await renderAtViewport(
      <div data-testid="oversized" style={{ height: 220, display: 'flex', alignItems: 'start' }}>
        <div style={{ height: 53 }}>content</div>
      </div>
    );

    const parent = document.querySelector('[data-testid="oversized"]') as HTMLElement;
    const union = childrenUnionBox(parent);

    expect(union).not.toBeNull();
    expect(box(parent).height).toBe(220);
    expect(union?.height).toBe(53);
    // The blind instrument, named so nobody reaches for it: the parent's own
    // scrollHeight reports 220 and the 167px of empty box is invisible in it.
    expect(parent.scrollHeight).toBe(220);
  });

  test('childrenUnionBox returns null for a childless element rather than a fake zero', async () => {
    await renderAtViewport(<div data-testid="empty" style={{ height: 40 }} />);
    const el = document.querySelector('[data-testid="empty"]') as HTMLElement;
    expect(childrenUnionBox(el)).toBeNull();
  });
});
