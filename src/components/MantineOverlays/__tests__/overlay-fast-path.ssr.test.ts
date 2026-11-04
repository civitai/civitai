import * as React from 'react';
import type { ReactElement, ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MantineCore from '@mantine/core';

/**
 * The SERVER markup of the closed-overlay fast path (`ssrClosedOverlayFastPath`).
 *
 * The contract is that a closed overlay's server HTML does not change: Mantine renders nothing for
 * a closed overlay but its trigger, so the fast path renders that trigger itself, with Mantine's
 * attributes — including the `useId` ids in `id`/`aria-controls`, and every id React generates
 * BELOW and AFTER the trigger. Each fixture below is rendered three times through
 * `renderToString`, the server's renderer: with `@mantine/core`'s components, with
 * `~/components/MantineOverlays` and the flag off, and with it on. The three strings must be equal.
 *
 * That alone would also pass if the fast path never ran, so every eligible fixture also asserts
 * that, with the flag on, Mantine's overlay component was never rendered on the server (counted
 * through a pass-through of `@mantine/core`'s exports), and with it off that it was.
 *
 * Node environment, as on the server: `window` is undefined, so Mantine's `useId` returns React's
 * id, exactly as during a real SSR.
 */

const counts = vi.hoisted(() => ({ Popover: 0, Menu: 0, HoverCard: 0, Tooltip: 0 }));

vi.mock('@mantine/core', async (importOriginal) => {
  const actual = await importOriginal<typeof MantineCore>();
  // Count renders without adding a fiber: each wrapper CALLS the original in its own fiber, so the
  // tree (and every useId) is exactly the original's.
  const countFn = <T extends (props: never) => unknown>(name: keyof typeof counts, fn: T): T =>
    Object.assign(function Counted(props: never) {
      counts[name]++;
      return fn(props);
    }, fn) as unknown as T;
  const tooltip = actual.Tooltip as unknown as {
    render: (props: unknown, ref: unknown) => unknown;
  };
  const CountedTooltip = Object.assign({}, actual.Tooltip, {
    render(props: unknown, ref: unknown) {
      counts.Tooltip++;
      return tooltip.render(props, ref);
    },
  });
  return {
    ...actual,
    Popover: countFn('Popover', actual.Popover as never),
    Menu: countFn('Menu', actual.Menu as never),
    HoverCard: countFn('HoverCard', actual.HoverCard as never),
    Tooltip: CountedTooltip,
  };
});

const Mantine = await import('@mantine/core');
const Ours = await import('~/components/MantineOverlays');
const { theme: appTheme } = await import('~/providers/ThemeProvider');

type Lib = {
  Tooltip: typeof Mantine.Tooltip;
  Popover: typeof Mantine.Popover;
  Menu: typeof Mantine.Menu;
  HoverCard: typeof Mantine.HoverCard;
};
const MANTINE_LIB: Lib = {
  Tooltip: Mantine.Tooltip,
  Popover: Mantine.Popover,
  Menu: Mantine.Menu,
  HoverCard: Mantine.HoverCard,
};
const OUR_LIB: Lib = {
  Tooltip: Ours.Tooltip,
  Popover: Ours.Popover,
  Menu: Ours.Menu,
  HoverCard: Ours.HoverCard,
};

// Loosely typed: the fixtures pass children as arguments, which the components' prop types declare
// as required props.
const h = React.createElement as unknown as (
  type: unknown,
  props?: Record<string, unknown> | null,
  ...children: unknown[]
) => ReactElement;

/** React's own id, rendered: pins that every id React generates is unchanged. */
function IdProbe({ name }: { name: string }) {
  const id = React.useId();
  return h('i', { 'data-probe': name, 'data-id': id });
}

const Child = React.forwardRef<HTMLButtonElement, { children?: ReactNode; className?: string }>(
  function Child(props, ref) {
    return h('button', { ...props, ref, type: 'button', 'data-child': '' });
  }
);

type Fixture = {
  name: string;
  /** Eligible for the fast path, i.e. the counted Mantine root must not render with the flag on. */
  fast: Array<keyof typeof counts>;
  tree: (L: Lib) => ReactElement;
};

const FIXTURES: Fixture[] = [
  {
    name: 'tooltip on a button',
    fast: ['Tooltip'],
    tree: (L) => h(L.Tooltip, { label: 'Tip' }, h(Mantine.Button, null, 'Hover me')),
  },
  {
    name: 'tooltip on a bare element (Mantine writes class="")',
    fast: ['Tooltip'],
    tree: (L) => h(L.Tooltip, { label: 'Tip', withArrow: true }, h('span', null, 'x')),
  },
  {
    name: "tooltip className on a child without one, and the child's own className winning",
    fast: ['Tooltip'],
    tree: (L) =>
      h(
        'div',
        null,
        h(L.Tooltip, { label: 'a', className: 'tip-cls' }, h('span', null, 'no class')),
        h(
          L.Tooltip,
          { label: 'b', className: 'tip-cls' },
          h('span', { className: 'own' }, 'own class')
        ),
        h(
          L.Tooltip,
          { label: 'c', disabled: true },
          h('span', { 'aria-describedby': 'kept', 'data-x': '1' }, 'described')
        )
      ),
  },
  {
    name: 'popover, portal, button target, ids under and after the trigger',
    fast: ['Popover'],
    tree: (L) =>
      h(
        'div',
        null,
        h(IdProbe, { name: 'before' }),
        h(
          L.Popover,
          { withinPortal: true, position: 'bottom' },
          h(L.Popover.Target, null, h(Child, null, h(IdProbe, { name: 'in-trigger' }), 'Open')),
          h(L.Popover.Dropdown, null, h(IdProbe, { name: 'in-dropdown' }), 'Body')
        ),
        h(IdProbe, { name: 'after' })
      ),
  },
  {
    name: "popover inline (the app theme's withinPortal: false), dropdown last",
    fast: ['Popover'],
    tree: (L) =>
      h(
        L.Popover,
        { width: 200 },
        h(L.Popover.Target, null, h(Mantine.Button, { variant: 'light' }, 'Inline')),
        h(L.Popover.Dropdown, null, 'Inline body')
      ),
  },
  {
    name: 'popover root props, a static id, popupType and target className',
    fast: ['Popover'],
    tree: (L) =>
      h(
        L.Popover,
        { id: 'static-id', withinPortal: true, className: 'root-cls', 'data-root': 'r' } as never,
        h(
          L.Popover.Target,
          { popupType: 'listbox', className: 'target-cls' } as never,
          h('span', { className: 'child-cls' }, 'Target')
        ),
        h(L.Popover.Dropdown, null, 'x')
      ),
  },
  {
    name: 'popover withRoles off, controlled closed',
    fast: ['Popover'],
    tree: (L) =>
      h(
        L.Popover,
        { withRoles: false, opened: false, onChange: () => undefined, withinPortal: true },
        h(L.Popover.Target, null, h('button', null, 'No roles')),
        h(L.Popover.Dropdown, null, 'x')
      ),
  },
  {
    name: 'tooltip inside a popover target',
    fast: ['Popover', 'Tooltip'],
    tree: (L) =>
      h(
        L.Popover,
        { withinPortal: true },
        h(
          L.Popover.Target,
          null,
          h(L.Tooltip, { label: 'Nested' }, h(Mantine.ActionIcon, { 'aria-label': 'more' }, 'i'))
        ),
        h(L.Popover.Dropdown, null, 'x')
      ),
  },
  {
    name: 'menu, action icon target, items',
    fast: ['Menu'],
    tree: (L) =>
      h(
        'div',
        null,
        h(
          L.Menu,
          { withinPortal: true, position: 'bottom-end', withArrow: true },
          h(
            L.Menu.Target,
            null,
            h(Mantine.ActionIcon, { 'aria-label': 'menu' }, h(IdProbe, { name: 'menu-in' }))
          ),
          h(
            L.Menu.Dropdown,
            null,
            h(L.Menu.Label, null, 'Label'),
            h(L.Menu.Item, null, 'One'),
            h(L.Menu.Divider),
            h(L.Menu.Item, null, 'Two')
          )
        ),
        h(IdProbe, { name: 'menu-after' })
      ),
  },
  {
    name: 'menu inline, hover trigger, a child with its own data-expanded',
    fast: ['Menu'],
    tree: (L) =>
      h(
        L.Menu,
        { trigger: 'hover', openDelay: 100 },
        h(L.Menu.Target, null, h('button', { 'data-expanded': 'mine' }, 'Hover menu')),
        h(L.Menu.Dropdown, null, h(L.Menu.Item, null, 'Item'))
      ),
  },
  {
    name: 'hover card, portal',
    fast: ['HoverCard'],
    tree: (L) =>
      h(
        L.HoverCard,
        { width: 280, withArrow: true, withinPortal: true },
        h(L.HoverCard.Target, null, h('a', { href: '/user/x' }, 'user')),
        h(L.HoverCard.Dropdown, null, 'card')
      ),
  },
  {
    name: 'hover card inline, dropdown last',
    fast: ['HoverCard'],
    tree: (L) =>
      h(
        L.HoverCard,
        { openDelay: 200 },
        h(L.HoverCard.Target, null, h(Mantine.Badge, null, 'badge')),
        h(L.HoverCard.Dropdown, null, 'card')
      ),
  },
  // Not eligible: these stay on Mantine with the flag on, and must still be byte-identical.
  {
    name: 'popover that starts open (inline)',
    fast: [],
    tree: (L) =>
      h(
        L.Popover,
        { defaultOpened: true },
        h(L.Popover.Target, null, h('button', null, 'Open')),
        h(L.Popover.Dropdown, null, 'Visible body')
      ),
  },
  {
    name: 'controlled open menu (inline)',
    fast: [],
    tree: (L) =>
      h(
        L.Menu,
        { opened: true, onChange: () => undefined, withinPortal: false },
        h(L.Menu.Target, null, h('button', null, 'Menu')),
        h(L.Menu.Dropdown, null, h(L.Menu.Item, null, 'Shown'))
      ),
  },
  {
    name: 'keepMounted popover (inline: Mantine renders the hidden dropdown)',
    fast: [],
    tree: (L) =>
      h(
        L.Popover,
        { keepMounted: true },
        h(L.Popover.Target, null, h('button', null, 'Kept')),
        h(L.Popover.Dropdown, null, 'Hidden body')
      ),
  },
  {
    name: 'inline popover whose dropdown is not its last child',
    fast: [],
    tree: (L) =>
      h(
        L.Popover,
        null,
        h(L.Popover.Dropdown, null, 'first'),
        h(L.Popover.Target, null, h('button', null, 'second'))
      ),
  },
  {
    name: 'tooltip that starts open',
    fast: [],
    tree: (L) => h(L.Tooltip, { label: 'Open tip', opened: true }, h('button', null, 'x')),
  },
];

const THEMES = [
  ['the default theme', undefined],
  ['the app theme', appTheme],
] as const;

function render(tree: ReactElement, theme: unknown, fastPath: boolean) {
  return renderToString(
    h(
      Mantine.MantineProvider,
      { theme: theme as never },
      h(Ours.OverlayFastPathContext.Provider, { value: fastPath }, tree)
    )
  );
}

beforeEach(() => {
  for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] = 0;
});

describe.each(THEMES)('closed-overlay fast path server markup, %s', (_label, theme) => {
  it.each(FIXTURES.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    const mantine = render(fixture.tree(MANTINE_LIB), theme, false);
    for (const key of fixture.fast) {
      // Control: the counter sees Mantine's component render on the server.
      expect(counts[key], `${key} rendered by @mantine/core`).toBeGreaterThan(0);
    }

    for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] = 0;
    const off = render(fixture.tree(OUR_LIB), theme, false);
    for (const key of fixture.fast)
      expect(counts[key], `${key} with the flag off`).toBeGreaterThan(0);

    for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] = 0;
    const on = render(fixture.tree(OUR_LIB), theme, true);
    for (const key of fixture.fast) expect(counts[key], `${key} with the flag on`).toBe(0);

    expect(off).toBe(mantine);
    expect(on).toBe(mantine);
  });
});

describe('the comparison can see a difference', () => {
  it('an open and a closed popover render different markup', () => {
    // Positive control for the byte comparison: inline, an open dropdown is in the HTML.
    const tree = (opened: boolean) =>
      h(
        Mantine.Popover,
        { opened, onChange: () => undefined, withinPortal: false },
        h(Mantine.Popover.Target, null, h('button', null, 'x')),
        h(Mantine.Popover.Dropdown, null, 'Body text')
      );
    const closed = render(tree(false), undefined, false);
    const open = render(tree(true), undefined, false);
    expect(closed).not.toBe(open);
    expect(open).toContain('Body text');
    expect(closed).not.toContain('Body text');
  });

  it('the trigger carries the attributes Mantine gives a closed popover target', () => {
    // Literal values, not derived from either implementation.
    const html = render(
      h(
        Ours.Popover,
        { id: 'pin', withinPortal: true },
        h(Ours.Popover.Target, null, h('button', null, 'x')),
        h(Ours.Popover.Dropdown, null, 'Body')
      ),
      undefined,
      true
    );
    // MantineProvider writes its <style> first; the trigger is the rest.
    expect(html.replace(/^<style[^>]*>[\s\S]*?<\/style>/, '')).toBe(
      '<button aria-haspopup="dialog" aria-expanded="false" aria-controls="pin-dropdown" id="pin-target" class="">x</button>'
    );
    expect(counts.Popover).toBe(0);
  });
});
