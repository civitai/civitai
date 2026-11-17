import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import type { Root } from 'react-dom/client';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import type * as SessionProviderModule from '~/providers/SessionProvider';
import type * as TrpcMod from '~/utils/trpc';
import type { FeatureAccess } from '~/server/services/feature-flags.service';

/**
 * The closed-overlay fast path (`ssrClosedOverlayFastPath`) in a real browser.
 *
 * 1. Hydration. The server HTML is rendered with `renderToString` through the REAL
 *    `FeatureFlagsProvider` (the flag travels as the server's serialised flags do) and hydrated
 *    with `hydrateRoot` over the same tree: no hydration error, no recoverable error. A control
 *    hydrates the same HTML with one label changed and must report a mismatch, so a silent
 *    detector cannot pass this.
 * 2. Behaviour on the FIRST interaction, for each overlay kind, run twice — once on Mantine's own
 *    component (flag off) and once on the fast path (flag on) — against the same literal
 *    expectations: first hover, click, programmatic click, Tab + Enter/Space/Arrow keys, Escape,
 *    open delays, controlled `opened`/`onChange`, the enter transition. With the flag on, each
 *    case first asserts that Mantine had NOT mounted (no portal node), so a fast path that quietly
 *    fell back to Mantine cannot pass either.
 * 3. The trigger is never remounted: same DOM node and same component state across the first
 *    interaction.
 */

const mocks = vi.hoisted(() => ({ flags: {} as Record<string, boolean> }));

vi.mock('~/providers/SessionProvider', async (orig) => ({
  ...(await orig<typeof SessionProviderModule>()),
  useSession: () => ({ data: null, status: 'unauthenticated', update: async () => null }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'user.getFeatureFlags': {
        useQuery: () => ({ data: mocks.flags, isSuccess: true, isError: false }),
      },
    }),
  };
});

const { FeatureFlagsProvider } = await import('~/providers/FeatureFlagsProvider');
const { Tooltip, Popover, Menu, HoverCard, OverlayFastPathContext } = await import(
  '~/components/MantineOverlays'
);
const { theme: appTheme } = await import('~/providers/ThemeProvider');

let park: HTMLElement;

beforeEach(async () => {
  // Somewhere for the pointer to rest that is not over any trigger (the browser page is shared
  // across test files, so the pointer starts wherever the previous file left it).
  park = document.createElement('div');
  park.setAttribute('data-testid', 'park');
  Object.assign(park.style, {
    position: 'fixed',
    left: '0px',
    top: '0px',
    width: '24px',
    height: '24px',
  });
  document.body.appendChild(park);
  await userEvent.hover(page.elementLocator(park));
});

afterEach(() => {
  park.remove();
});

const portalCount = () => document.querySelectorAll('[data-portal="true"]').length;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PAD: React.CSSProperties = { padding: '160px 0 0 240px' };

function Shell({ fast, children }: { fast: boolean; children: React.ReactNode }) {
  return (
    <MantineProvider theme={appTheme}>
      <OverlayFastPathContext.Provider value={fast}>
        <div style={PAD}>{children}</div>
      </OverlayFastPathContext.Provider>
    </MantineProvider>
  );
}

/** Render, and pin whether Mantine mounted before any interaction (it portals on mount). */
async function mount(fast: boolean, ui: React.ReactElement, portalsWhenMantine: number) {
  const before = portalCount();
  const screen = await render(<Shell fast={fast}>{ui}</Shell>);
  await sleep(0);
  expect(portalCount() - before, 'portal nodes before the first interaction').toBe(
    fast ? 0 : portalsWhenMantine
  );
  return screen;
}

function Stateful() {
  const [value] = React.useState(() => Math.random().toString(36).slice(2));
  return <span data-testid="stateful" data-value={value} />;
}

describe.each([
  ['Mantine (flag off)', false],
  ['fast path (flag on)', true],
] as const)('%s', (_label, fast) => {
  test('Tooltip: the first hover opens it, leaving closes it, the trigger is not remounted', async () => {
    await mount(
      fast,
      <Tooltip label="Tip text" withinPortal>
        <button type="button">
          Trigger <Stateful />
        </button>
      </Tooltip>,
      1
    );
    const trigger = page.getByRole('button', { name: 'Trigger' });
    const node = trigger.element();
    const value = page.getByTestId('stateful').element().getAttribute('data-value');

    await userEvent.hover(trigger);
    await expect.element(page.getByRole('tooltip')).toHaveTextContent('Tip text');
    expect(trigger.element()).toBe(node);
    expect(page.getByTestId('stateful').element().getAttribute('data-value')).toBe(value);

    await userEvent.hover(page.elementLocator(park));
    await expect.poll(() => document.querySelector('[role="tooltip"]')).toBeNull();
  });

  test('Tooltip: openDelay holds the first hover back for the delay', async () => {
    await mount(
      fast,
      <Tooltip label="Delayed tip" openDelay={1500} withinPortal>
        <button type="button">Delayed</button>
      </Tooltip>,
      1
    );
    await userEvent.hover(page.getByRole('button', { name: 'Delayed' }));
    // The delay dwarfs the sleep, so a slow CI box cannot open it before the absence check.
    await sleep(200);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await expect
      .element(page.getByRole('tooltip'), { timeout: 5_000 })
      .toHaveTextContent('Delayed tip');
  });

  test('Tooltip with focus events: the first Tab opens it', async () => {
    await mount(
      fast,
      <Tooltip label="Focus tip" events={{ hover: true, focus: true, touch: false }} withinPortal>
        <button type="button">Focusable</button>
      </Tooltip>,
      1
    );
    await userEvent.tab();
    expect(document.activeElement).toBe(page.getByRole('button', { name: 'Focusable' }).element());
    await expect.element(page.getByRole('tooltip')).toHaveTextContent('Focus tip');
  });

  test('Popover: the first click opens it, a second closes it, onChange both times', async () => {
    const onChange = vi.fn();
    await mount(
      fast,
      <Popover withinPortal onChange={onChange}>
        <Popover.Target>
          <button type="button">
            Open popover <Stateful />
          </button>
        </Popover.Target>
        <Popover.Dropdown>Popover body</Popover.Dropdown>
      </Popover>,
      1
    );
    const trigger = page.getByRole('button', { name: 'Open popover' });
    const node = trigger.element();
    const value = page.getByTestId('stateful').element().getAttribute('data-value');
    expect(node).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(trigger);
    await expect.element(page.getByRole('dialog')).toHaveTextContent('Popover body');
    expect(trigger.element()).toBe(node);
    expect(node).toHaveAttribute('aria-expanded', 'true');
    expect(node.getAttribute('aria-controls')).toBe(page.getByRole('dialog').element().id);
    expect(page.getByTestId('stateful').element().getAttribute('data-value')).toBe(value);
    expect(onChange).toHaveBeenLastCalledWith(true);

    await userEvent.click(trigger);
    await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  test('Popover: a programmatic click with no pointer or focus first opens it', async () => {
    await mount(
      fast,
      <Popover withinPortal>
        <Popover.Target>
          <button type="button">Scripted</button>
        </Popover.Target>
        <Popover.Dropdown>Scripted body</Popover.Dropdown>
      </Popover>,
      1
    );
    (page.getByRole('button', { name: 'Scripted' }).element() as HTMLElement).click();
    await expect.element(page.getByRole('dialog')).toHaveTextContent('Scripted body');
  });

  test('Popover inline (app theme): opens beside its target, Escape closes, focus returns', async () => {
    await mount(
      fast,
      <div data-testid="host">
        <Popover trapFocus>
          <Popover.Target>
            <button type="button">Inline</button>
          </Popover.Target>
          <Popover.Dropdown>
            <button type="button">Inside</button>
          </Popover.Dropdown>
        </Popover>
      </div>,
      0
    );
    const trigger = page.getByRole('button', { name: 'Inline' });
    await userEvent.click(trigger);
    const dialog = page.getByRole('dialog');
    await expect.element(dialog).toBeVisible();
    // Inline: the dropdown is the target's next sibling inside the host, as Mantine places it.
    expect(dialog.element().parentElement).toBe(page.getByTestId('host').element());
    expect(trigger.element().nextElementSibling).toBe(dialog.element());
    await expect.poll(() => dialog.element().contains(document.activeElement)).toBe(true);

    await userEvent.keyboard('{Escape}');
    await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger.element());
  });

  test('Popover controlled: the trigger toggles state, click outside calls onChange(false)', async () => {
    const onEntered = vi.fn();
    function Controlled() {
      const [opened, setOpened] = React.useState(false);
      return (
        <Popover
          opened={opened}
          onChange={setOpened}
          withinPortal
          transitionProps={{ duration: 60 }}
          onEnterTransitionEnd={onEntered}
        >
          <Popover.Target>
            <button type="button" onClick={() => setOpened((o) => !o)}>
              Controlled
            </button>
          </Popover.Target>
          <Popover.Dropdown>Controlled body</Popover.Dropdown>
        </Popover>
      );
    }
    await mount(fast, <Controlled />, 1);
    await userEvent.click(page.getByRole('button', { name: 'Controlled' }));
    await expect.element(page.getByRole('dialog')).toHaveTextContent('Controlled body');
    await expect.poll(() => onEntered.mock.calls.length).toBe(1);

    await userEvent.click(page.elementLocator(park));
    await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
  });

  test('Popover opened from outside: it opens with its enter transition', async () => {
    const onEntered = vi.fn();
    function External() {
      const [opened, setOpened] = React.useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpened(true)}>
            Elsewhere
          </button>
          <Popover
            opened={opened}
            onChange={setOpened}
            withinPortal
            transitionProps={{ duration: 60 }}
            onEnterTransitionEnd={onEntered}
          >
            <Popover.Target>
              <button type="button">Anchor</button>
            </Popover.Target>
            <Popover.Dropdown>External body</Popover.Dropdown>
          </Popover>
        </>
      );
    }
    await mount(fast, <External />, 1);
    await userEvent.click(page.getByRole('button', { name: 'Elsewhere' }));
    await expect.element(page.getByRole('dialog')).toHaveTextContent('External body');
    await expect.poll(() => onEntered.mock.calls.length).toBe(1);
    expect(page.getByRole('button', { name: 'Anchor' }).element()).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  test('Menu: the first click opens it and an item click closes it', async () => {
    const onItem = vi.fn();
    await mount(
      fast,
      <Menu withinPortal>
        <Menu.Target>
          <button type="button">Actions</button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item onClick={onItem}>First item</Menu.Item>
          <Menu.Item>Second item</Menu.Item>
        </Menu.Dropdown>
      </Menu>,
      1
    );
    const trigger = page.getByRole('button', { name: 'Actions' });
    expect(trigger.element()).toHaveAttribute('aria-haspopup', 'menu');
    await userEvent.click(trigger);
    await expect.element(page.getByRole('menu')).toBeVisible();
    expect(trigger.element()).toHaveAttribute('aria-expanded', 'true');
    expect(trigger.element()).toHaveAttribute('data-expanded', 'true');
    await userEvent.click(page.getByRole('menuitem', { name: 'First item' }));
    expect(onItem).toHaveBeenCalledTimes(1);
    await expect.poll(() => document.querySelector('[role="menu"]')).toBeNull();
  });

  test.each([
    ['Enter', '{Enter}'],
    ['Space', ' '],
  ])(
    'Menu keyboard: Tab, %s opens, ArrowDown walks the items, Escape closes and returns focus',
    async (_key, press) => {
      await mount(
        fast,
        <Menu withinPortal>
          <Menu.Target>
            <button type="button">Keyboard menu</button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item>First item</Menu.Item>
            <Menu.Item>Second item</Menu.Item>
          </Menu.Dropdown>
        </Menu>,
        1
      );
      const trigger = page.getByRole('button', { name: 'Keyboard menu' });
      await userEvent.tab();
      expect(document.activeElement).toBe(trigger.element());
      await userEvent.keyboard(press);
      await expect.element(page.getByRole('menu')).toBeVisible();
      await userEvent.keyboard('{ArrowDown}');
      await expect.poll(() => document.activeElement?.textContent).toBe('First item');
      await userEvent.keyboard('{ArrowDown}');
      await expect.poll(() => document.activeElement?.textContent).toBe('Second item');
      await userEvent.keyboard('{Escape}');
      await expect.poll(() => document.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(trigger.element());
    }
  );

  test('Menu with trigger="hover": the first hover opens it', async () => {
    await mount(
      fast,
      <Menu trigger="hover" openDelay={0} closeDelay={50} withinPortal>
        <Menu.Target>
          <button type="button">Hover menu</button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item>Hovered item</Menu.Item>
        </Menu.Dropdown>
      </Menu>,
      1
    );
    await userEvent.hover(page.getByRole('button', { name: 'Hover menu' }));
    await expect.element(page.getByRole('menu')).toBeVisible();
    await userEvent.hover(page.elementLocator(park));
    await expect.poll(() => document.querySelector('[role="menu"]')).toBeNull();
  });

  test('HoverCard: the first hover opens it after openDelay, leaving closes it', async () => {
    await mount(
      fast,
      <HoverCard openDelay={1500} closeDelay={50} withinPortal>
        <HoverCard.Target>
          <a href="#user">Some user</a>
        </HoverCard.Target>
        <HoverCard.Dropdown>Card body</HoverCard.Dropdown>
      </HoverCard>,
      1
    );
    await userEvent.hover(page.getByRole('link', { name: 'Some user' }));
    await sleep(120);
    expect(document.body.textContent).not.toContain('Card body');
    await expect.element(page.getByText('Card body'), { timeout: 5_000 }).toBeVisible();
    await userEvent.hover(page.elementLocator(park));
    await expect.poll(() => document.body.textContent?.includes('Card body')).toBe(false);
  });

  test('Tooltip > Menu.Target > button: a programmatic click as the very first event opens the menu', async () => {
    // The nesting `no-menu-target-tooltip-nesting.test.ts` requires. Both overlays arm on this one
    // click; arming the Tooltip re-renders the Menu target with a new ref, and the Menu's own arming
    // listener must survive that for the same click to reach Mantine's toggle.
    await mount(
      fast,
      <Menu withinPortal>
        <Tooltip label="Menu tip" withinPortal>
          <Menu.Target>
            <button type="button">Tipped menu</button>
          </Menu.Target>
        </Tooltip>
        <Menu.Dropdown>
          <Menu.Item>Tipped item</Menu.Item>
        </Menu.Dropdown>
      </Menu>,
      2
    );
    const trigger = page.getByRole('button', { name: 'Tipped menu' }).element() as HTMLElement;
    trigger.click();
    await expect.element(page.getByRole('menu')).toBeVisible();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  test('Tooltip inside a Popover target: both work on the first interaction', async () => {
    await mount(
      fast,
      <Popover withinPortal>
        <Popover.Target>
          <Tooltip label="Nested tip" withinPortal>
            <button type="button">Nested</button>
          </Tooltip>
        </Popover.Target>
        <Popover.Dropdown>Nested body</Popover.Dropdown>
      </Popover>,
      2
    );
    const trigger = page.getByRole('button', { name: 'Nested' });
    await userEvent.hover(trigger);
    await expect.element(page.getByRole('tooltip')).toHaveTextContent('Nested tip');
    await userEvent.click(trigger);
    await expect.element(page.getByRole('dialog')).toHaveTextContent('Nested body');
  });
});

// Each wrapper re-exposes Mantine's statics through `defineLazyStatics`, from a string list, and is
// exported cast to Mantine's type: a key missing from that list still typechecks, but reads
// `undefined` at runtime (`<Tooltip.Group>` then throws "Element type is invalid"). The keys are
// written out here, not read from the wrappers, so dropping one from a list fails this test.
describe.each<[string, () => unknown, string[]]>([
  ['Tooltip', () => Tooltip, ['Group', 'Floating', 'classes', 'extend', 'withProps']],
  ['Popover', () => Popover, ['extend']],
  ['Menu', () => Menu, ['extend', 'withProps', 'classes', 'Item', 'Label', 'Divider']],
  ['HoverCard', () => HoverCard, ['extend']],
])("%s mirrors Mantine's statics", (name, wrapper, keys) => {
  test.each(keys)("%s is Mantine's own reference", async (key) => {
    const Mantine = (await import('@mantine/core')) as unknown as Record<
      string,
      Record<string, unknown>
    >;
    const own = Mantine[name][key];
    // Control: Mantine has the static, so the identity below cannot pass as undefined === undefined.
    expect(own, `Mantine.${name}.${key}`).toBeDefined();
    expect((wrapper() as unknown as Record<string, unknown>)[key], `${name}.${key}`).toBe(own);
  });
});

function IdProbe({ name }: { name: string }) {
  const id = React.useId();
  return <i data-probe={name} data-id={id} />;
}

function HydrationBeacon() {
  const [hydrated, setHydrated] = React.useState(false);
  React.useEffect(() => setHydrated(true), []);
  return <i data-testid="hydrated" data-hydrated={String(hydrated)} />;
}

function OverlayPage({ label = 'Hydrated tip' }: { label?: string }) {
  return (
    <div>
      <IdProbe name="top" />
      <Tooltip label={label}>
        <button type="button">Tip trigger</button>
      </Tooltip>
      <Popover withinPortal>
        <Popover.Target>
          <button type="button">
            Popover trigger <IdProbe name="in-popover" />
          </button>
        </Popover.Target>
        <Popover.Dropdown>Hydrated popover body</Popover.Dropdown>
      </Popover>
      <Popover>
        <Popover.Target>
          <Tooltip label="Nested">
            <button type="button">Inline popover trigger</button>
          </Tooltip>
        </Popover.Target>
        <Popover.Dropdown>Inline body</Popover.Dropdown>
      </Popover>
      <Menu withinPortal>
        <Menu.Target>
          <button type="button">{label === 'Hydrated tip' ? 'Menu trigger' : 'Changed'}</button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item>Item</Menu.Item>
        </Menu.Dropdown>
      </Menu>
      <HoverCard>
        <HoverCard.Target>
          <a href="#card">Card trigger</a>
        </HoverCard.Target>
        <HoverCard.Dropdown>Card</HoverCard.Dropdown>
      </HoverCard>
      <IdProbe name="bottom" />
    </div>
  );
}

function AppTree({ fast, label }: { fast: boolean; label?: string }) {
  const [queryClient] = React.useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <MantineProvider theme={appTheme}>
        <FeatureFlagsProvider
          flags={(fast ? { ssrClosedOverlayFastPath: true } : {}) as unknown as FeatureAccess}
        >
          <OverlayPage label={label} />
          <HydrationBeacon />
        </FeatureFlagsProvider>
      </MantineProvider>
    </QueryClientProvider>
  );
}

const HYDRATION_RE =
  /(Hydration failed|An error occurred during hydration|The server HTML was replaced|Expected server HTML|did not match|Text content does not match)/i;

describe('server HTML hydrates without a mismatch', () => {
  let consoleErrors: string[] = [];
  let recoverable: string[] = [];
  let restore: (() => void) | null = null;
  const roots: Root[] = [];
  const containers: HTMLElement[] = [];

  beforeEach(() => {
    mocks.flags = {};
    consoleErrors = [];
    recoverable = [];
    const original = console.error;
    console.error = ((...args: unknown[]) => {
      consoleErrors.push(args.map((a) => String(a)).join(' '));
      original.apply(console, args as []);
    }) as typeof console.error;
    restore = () => {
      console.error = original;
    };
  });

  afterEach(() => {
    restore?.();
    for (const r of roots.splice(0)) r.unmount();
    for (const c of containers.splice(0)) c.remove();
  });

  async function hydrate(html: string, tree: React.ReactElement) {
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    containers.push(container);
    roots.push(
      hydrateRoot(container, tree, {
        onRecoverableError: (err) => {
          recoverable.push(err instanceof Error ? err.message : String(err));
        },
      })
    );
    await vi.waitFor(
      () =>
        expect(
          container.querySelector('[data-testid="hydrated"]')?.getAttribute('data-hydrated')
        ).toBe('true'),
      { timeout: 10_000 }
    );
    return container;
  }

  test('the flag is on: same HTML as Mantine, hydrates clean, Mantine mounts on first use', async () => {
    const htmlOn = renderToString(<AppTree fast />);
    const htmlOff = renderToString(<AppTree fast={false} />);
    // The fast path changes no server byte.
    expect(htmlOn).toBe(htmlOff);

    const before = portalCount();
    const container = await hydrate(htmlOn, <AppTree fast />);
    expect(recoverable).toEqual([]);
    expect(consoleErrors.filter((e) => HYDRATION_RE.test(e))).toEqual([]);
    // The flag reached the hydrating render: nothing of Mantine's mounted, so no portal nodes.
    expect(portalCount() - before).toBe(0);

    const trigger = container.querySelector('button[aria-haspopup="dialog"]') as HTMLElement;
    expect(trigger.textContent).toContain('Popover trigger');
    await userEvent.click(page.elementLocator(trigger));
    await expect.element(page.getByText('Hydrated popover body')).toBeVisible();
  });

  test('the flag is off: hydrates clean, and Mantine mounted its portals (control)', async () => {
    const html = renderToString(<AppTree fast={false} />);
    const before = portalCount();
    await hydrate(html, <AppTree fast={false} />);
    expect(recoverable).toEqual([]);
    expect(consoleErrors.filter((e) => HYDRATION_RE.test(e))).toEqual([]);
    // Tooltip ×3 and the portalled Popover and Menu: Mantine's closed overlays portal on mount.
    expect(portalCount() - before).toBeGreaterThan(0);
  });

  test('control: a tree that differs from its server HTML is reported', async () => {
    const html = renderToString(<AppTree fast />);
    await hydrate(html, <AppTree fast label="Different" />);
    const reported = recoverable.length + consoleErrors.filter((e) => HYDRATION_RE.test(e)).length;
    expect(reported).toBeGreaterThan(0);
  });
});
