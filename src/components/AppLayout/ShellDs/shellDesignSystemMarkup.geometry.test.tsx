/**
 * THE PAGE SHELL ON `@civitai/components` MARKUP (flag `shellDesignSystemMarkup`) — MEASURED
 * AGAINST THE MANTINE SHELL IT REPLACES, IN THE REAL APP CASCADE.
 *
 * The flag swaps the header row's `Grid`/`Button`/`ActionIcon`/`Divider`, the sub-nav tab pills
 * and the footer's links, social icons, consent links and scroll-to-top button for plain
 * `data-civitai-ui="button"` elements styled by `@civitai/components` + `ShellDs.module.css`. The
 * requirement is that nobody can tell: same boxes, same colours, same hover and focus, same
 * accessible names, hrefs, `target`/`rel` and attributes.
 *
 * So the core of this file renders the SAME shell twice — flag OFF (Mantine) and flag ON — and
 * compares every control, in light and dark, at a desktop and a phone width. A literal-value
 * section pins the markup contract itself, so a change that alters BOTH arms equally (which a
 * comparison cannot see) still reddens.
 *
 * WHY THIS TIER. It is the only one with the production cascade: the `@layer` order from
 * `_document.tsx`, `globals.css` (Tailwind Preflight in its layer, the `theme` layer's
 * `button { border: none }`), Mantine's layered sheets and `@civitai/components`' sheet. The
 * design-system rules losing to any of those is the "renders borderless" failure this feature is
 * most exposed to, and the `component` tier, which loads none of them, cannot see it.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup } from 'vitest-browser-react';
import { MantineProvider } from '@mantine/core';
import type { Viewport } from '../../../../test/geometry-setup';
import { cascadeEvidence, nextLayout, renderAtViewport } from '../../../../test/geometry-setup';
import type * as TrpcModule from '~/utils/trpc';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as BrowsingAddonsModule from '~/providers/BrowsingSettingsAddonsProvider';
import type * as ConsentModule from '~/components/Consent/consent.context';
import type * as PrivacyUiModule from '~/components/Consent/privacy-ui';

const state = vi.hoisted(() => ({
  ds: false,
  live: false,
  user: null as null | { id: number; username: string },
}));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({
    // HomeTabs' nav registry (the same set `HomeTabs.geometry.test.tsx` uses).
    articles: true,
    bounties: true,
    comicCreator: true,
    challengePlatform: true,
    crucible: true,
    cosmeticShop: true,
    model3dFeed: true,
    userHubs: true,
    auctions: true,
    vault: true,
    // Footer: `safety` and `bugsPage` add two links; `isRed` would add the 2257 link.
    safety: true,
    bugsPage: true,
    isRed: false,
    isGreen: true,
    canWrite: true,
    shellDesignSystemMarkup: state.ds,
  }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.user }));
vi.mock('~/components/UserSettings/hooks', () => ({ useCurrentUserSettings: () => ({}) }));
vi.mock('~/hooks/useDomainColor', () => ({ useDomainColor: () => 'green' }));
vi.mock('~/hooks/useIsLive', () => ({ useIsLive: () => state.live }));
vi.mock('~/components/ScrollArea/ScrollAreaContext', () => ({
  useScrollAreaRef: () => ({ current: null }),
}));
vi.mock('~/providers/BrowsingSettingsAddonsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingAddonsModule>()),
  useBrowsingSettingsAddons: () => ({ settings: { excludedFooterLinks: [] } }),
}));
// Both consent links render: they are part of the footer row being compared.
vi.mock('~/components/Consent/consent.context', async (importOriginal) => ({
  ...(await importOriginal<typeof ConsentModule>()),
  useThirdPartyConsent: () => ({ required: true, reset: vi.fn() }),
}));
vi.mock('~/components/Consent/privacy-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof PrivacyUiModule>();
  actual.usePrivacyUiStore.setState({ visible: true });
  return actual;
});
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof TrpcModule>()), trpc: makeTrpcProxy() };
});

// The shell's interactive / portal children stay on Mantine in BOTH arms and are not under test,
// so each is a fixed-size stub: identical in both renders, and it keeps their dependency graphs
// out of this file.
function stub(name: string) {
  function Stub() {
    return <span data-stub={name} style={{ display: 'inline-block', width: 28, height: 28 }} />;
  }
  Stub.displayName = `Stub(${name})`;
  return Stub;
}
vi.mock('~/components/Logo/Logo', () => ({ Logo: stub('logo') }));
vi.mock('~/components/SupportButton/SupportButton', () => ({ SupportButton: stub('support') }));
vi.mock('~/components/ReadOnlyNotice/ReadOnlyNotice', () => ({ ReadOnlyNotice: stub('ro') }));
vi.mock('~/components/BrowsingMode/BrowsingMode', () => ({ BrowsingModeIcon: stub('browse') }));
vi.mock('~/components/Chat/ChatButton', () => ({ ChatButton: stub('chat') }));
vi.mock('~/components/Chat/useChatEnabled', () => ({ useChatEnabled: () => false }));
vi.mock('~/components/CivitaiLink/CivitaiLinkPopover', () => ({
  CivitaiLinkPopover: stub('link'),
}));
vi.mock('~/components/Moderation/ImpersonateButton', () => ({
  ImpersonateButton: stub('impersonate'),
}));
vi.mock('~/components/Moderation/ModerationNav', () => ({ ModerationNav: stub('mod') }));
vi.mock('~/components/Notifications/NotificationBell', () => ({
  NotificationBell: stub('bell'),
}));
vi.mock('~/components/ResourceLoad/resource-load.utils', () => ({
  ResourceLoadDrain: stub('drain'),
}));
vi.mock('~/components/Resource/UploadTracker', () => ({ UploadTracker: stub('upload') }));
vi.mock('~/components/AppLayout/AppHeader/UserMenu', () => ({ UserMenu: stub('user-menu') }));
vi.mock('~/components/AppLayout/AppHeader/CreateMenu', () => ({ CreateMenu: stub('create') }));
vi.mock('~/components/Alerts/YellowBuzzMigrationNotice', () => ({
  YellowBuzzMigrationNotice: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('~/components/Support/SupportMenu', () => ({ SupportMenu: stub('support-menu') }));
vi.mock('~/components/Assistant/AssistantButton', () => ({ AssistantButton: () => null }));

const { AppHeader } = await import('~/components/AppLayout/AppHeader/AppHeader');
const { AppFooter } = await import('~/components/AppLayout/AppFooter');
const { HomeTabs } = await import('~/components/HomeContentToggle/HomeContentToggle');
const { theme } = await import('~/providers/ThemeProvider');

type Scheme = 'light' | 'dark';

const DESKTOP: Viewport = { width: 1280, height: 900 };
const PHONE: Viewport = { width: 390, height: 844 };

/** Mantine component roots that must not appear in the flag-ON shell (the More menu aside). */
const MANTINE_REPLACED = [
  '.mantine-Button-root',
  '.mantine-ActionIcon-root',
  '.mantine-Grid-root',
  '.mantine-Grid-col',
  '.mantine-Text-root',
  '.mantine-Divider-root',
].join(', ');

/**
 * The production shape around the shell: a query container (`ContainerProvider` in BaseLayout —
 * the header's `@md:` / `@max-md:` classes are CONTAINER queries and match nothing without one),
 * this app's Mantine theme (so `--mantine-color-*` carry civitai's palette, not Mantine's
 * defaults), and the header / sub-nav row / footer stacked in a column like `AppLayout`.
 */
function Shell() {
  return (
    <div className="@container" style={{ height: 800 }}>
      <MantineProvider theme={theme}>
        <div className="flex h-full flex-col" data-shell-under-test>
          <AppHeader
            renderSearchComponent={() => <div data-stub="search" style={{ height: 36 }} />}
          />
          <div className="flex items-start justify-between gap-2 px-2 py-1">
            <HomeTabs />
          </div>
          <div className="flex-1" />
          <AppFooter />
        </div>
      </MantineProvider>
      {/* Where the pointer is parked before anything is measured, so no control is left
          `:hover`ed by an earlier render. Above everything, and outside every control. */}
      <div
        data-pointer-park
        style={{ position: 'fixed', top: 0, left: 0, width: 4, height: 4, zIndex: 10000 }}
      />
    </div>
  );
}

async function parkPointer() {
  const park = document.querySelector<HTMLElement>('[data-pointer-park]');
  if (!park) throw new Error('pointer park missing');
  await userEvent.hover(park);
  await nextLayout();
}

function shellRoot(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-shell-under-test]');
  if (!el) throw new Error('shell did not render');
  return el;
}

async function renderShell({
  ds,
  scheme,
  viewport,
}: {
  ds: boolean;
  scheme: Scheme;
  viewport: Viewport;
}) {
  state.ds = ds;
  await renderAtViewport(<Shell />, viewport);
  // Set AFTER mount: both Mantine providers write the attribute from a layout effect on mount, the
  // outer (harness, light) one last. Nothing rewrites it afterwards.
  document.documentElement.setAttribute('data-mantine-color-scheme', scheme);
  await nextLayout();
  if (document.documentElement.getAttribute('data-mantine-color-scheme') !== scheme)
    throw new Error(`colour scheme did not stick at ${scheme}`);
  await parkPointer();
}

/** Every link and button in the shell, in document order — stubs excluded. */
function controls(): HTMLElement[] {
  return [...shellRoot().querySelectorAll<HTMLElement>('a, button')].filter(
    (el) => !el.closest('[data-stub]')
  );
}

/** What a user or assistive technology can observe about a control, minus styling. */
function semantics(el: HTMLElement) {
  return {
    tag: el.tagName.toLowerCase(),
    text: (el.textContent ?? '').trim(),
    href: el.getAttribute('href'),
    target: el.getAttribute('target'),
    rel: el.getAttribute('rel'),
    type: el.getAttribute('type'),
    title: el.getAttribute('title'),
    ariaLabel: el.getAttribute('aria-label'),
    role: el.getAttribute('role'),
    tabIndex: el.tabIndex,
    disabled: el.hasAttribute('disabled'),
  };
}

/**
 * Compared on the control's ROOT. Deliberately absent: `white-space`, `text-align` and
 * `text-transform`. Mantine sets those on the label span INSIDE its button, the design-system
 * markup on the root, so the root's computed value legitimately differs; what they DO — no
 * wrapping, centred, capitalised — is measured by `ink` (the rect of the text and icons),
 * which moves if any of them is lost.
 */
const STYLE_PROPS = [
  'box-sizing',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'font-size',
  'font-weight',
  'font-family',
  'line-height',
  'letter-spacing',
  'color',
  'background-color',
  'background-image',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-style',
  'border-left-style',
  'border-top-color',
  'border-left-color',
  'border-top-left-radius',
  'border-bottom-right-radius',
  'cursor',
  'text-decoration-line',
  'user-select',
  'overflow-x',
  'overflow-y',
  'opacity',
  'transform',
] as const;

const r1 = (n: number) => Math.round(n * 10) / 10;
function rect(r: DOMRect) {
  return { x: r1(r.x), y: r1(r.y), w: r1(r.width), h: r1(r.height) };
}

/**
 * Where the INK sits inside a control: the union of its text runs and its icons, relative to the
 * control's box. Leaves only — a range over the element's contents would also include Mantine's
 * full-height wrapper spans (`inner`, `label`), which the design-system markup does not have, and
 * report that as a difference in content placement when nothing visible moved.
 */
function inkRect(el: HTMLElement): DOMRect | null {
  const rects: DOMRect[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!(n.textContent ?? '').trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    rects.push(range.getBoundingClientRect());
  }
  el.querySelectorAll('svg').forEach((svg) => rects.push(svg.getBoundingClientRect()));
  const real = rects.filter((r) => r.width > 0 && r.height > 0);
  if (!real.length) return null;
  const left = Math.min(...real.map((r) => r.left));
  const top = Math.min(...real.map((r) => r.top));
  const right = Math.max(...real.map((r) => r.right));
  const bottom = Math.max(...real.map((r) => r.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

/** The box, the computed style, and where the ink (text + icons) sits inside the box. */
function look(el: HTMLElement) {
  const s = getComputedStyle(el);
  const box = el.getBoundingClientRect();
  const ink = inkRect(el);
  return {
    box: rect(box),
    ink: ink ? rect(new DOMRect(ink.x - box.x, ink.y - box.y, ink.width, ink.height)) : null,
    style: Object.fromEntries(STYLE_PROPS.map((p) => [p, s.getPropertyValue(p)])),
  };
}

/** The non-control boxes whose geometry the flag also replaces: the header grid and divider. */
function layoutBoxes() {
  const header = shellRoot().querySelector('header');
  const footer = shellRoot().querySelector('footer');
  if (!header || !footer) throw new Error('header/footer missing');
  // By class, not index: Mantine's `Grid` also renders `<style>` siblings into the header.
  const gridRoot = header.querySelector<HTMLElement>(':scope > .justify-between');
  if (!gridRoot) throw new Error('header row missing');
  const inner = gridRoot.firstElementChild as HTMLElement;
  const cols = [...inner.children].filter((c) => getComputedStyle(c).display !== 'none');
  const copyright = [...footer.querySelectorAll('p')].find((p) => p.textContent?.includes('©'));
  const divider = header.querySelector('[role="separator"]');
  return {
    header: rect(header.getBoundingClientRect()),
    gridRoot: rect(gridRoot.getBoundingClientRect()),
    inner: rect(inner.getBoundingClientRect()),
    cols: cols.map((c) => rect(c.getBoundingClientRect())),
    footer: rect(footer.getBoundingClientRect()),
    copyright: copyright
      ? {
          box: rect(copyright.getBoundingClientRect()),
          style: Object.fromEntries(
            ['font-size', 'font-weight', 'line-height', 'color', 'margin-top', 'white-space'].map(
              (p) => [p, getComputedStyle(copyright).getPropertyValue(p)]
            )
          ),
        }
      : null,
    divider: divider
      ? {
          box: rect(divider.getBoundingClientRect()),
          color: getComputedStyle(divider).borderInlineStartColor,
          width: getComputedStyle(divider).borderInlineStartWidth,
          style: getComputedStyle(divider).borderInlineStartStyle,
        }
      : null,
  };
}

/** The state the user sees while pointing at / tabbing to a control. */
async function interactive(el: HTMLElement) {
  await userEvent.hover(el);
  await nextLayout();
  const hovered = getComputedStyle(el);
  const hover = {
    bg: hovered.backgroundColor,
    color: hovered.color,
    border: hovered.borderTopColor,
  };
  await parkPointer();
  el.focus({ focusVisible: true, preventScroll: true } as FocusOptions);
  await nextLayout();
  const focused = getComputedStyle(el);
  const focus = {
    outlineStyle: focused.outlineStyle,
    outlineWidth: focused.outlineWidth,
    outlineColor: focused.outlineColor,
    outlineOffset: focused.outlineOffset,
  };
  el.blur();
  return { hover, focus };
}

async function capture() {
  const els = controls();
  return {
    semantics: els.map(semantics),
    looks: els.map(look),
    layout: layoutBoxes(),
    mantineRoots: [...shellRoot().querySelectorAll(MANTINE_REPLACED)].map((e) =>
      (e.textContent ?? '').trim()
    ),
    dsRoots: shellRoot().querySelectorAll('[data-civitai-ui="button"]').length,
  };
}

/**
 * One representative of each control KIND whose hover and focus are compared. Scroll-to-top is
 * not one: at rest it is translated down behind the footer bar, so a real pointer cannot reach it
 * (its resting look is still compared with every other control).
 */
function representatives(): HTMLElement[] {
  const root = shellRoot();
  const pick = (sel: string) => {
    const el = root.querySelector<HTMLElement>(sel);
    if (!el) throw new Error(`representative ${sel} not rendered`);
    return el;
  };
  const visible = (el: HTMLElement) => el.getClientRects().length > 0;
  const signIn = root.querySelector<HTMLElement>('a[href^="/login"]');
  return [
    pick('footer a[href="/content/tos"]'), // footer link: subtle gray xs
    pick('footer a[href="/discord"]'), // social: subtle gray ActionIcon lg, radius xl
    pick('a[href="/models"]'), // sub-nav pill: default variant + Tailwind overrides
    pick('footer button[type="button"]:not([aria-label])'), // consent: subtle gray xs <button>
    // Sign In (default variant, sm) is in the desktop column; the search icon (subtle gray
    // ActionIcon md) in the phone one. Whichever this width shows.
    signIn && visible(signIn) ? signIn : pick('button[aria-label="Search"]'),
  ];
}

beforeEach(() => {
  state.ds = false;
  state.live = false;
  state.user = null;
});

afterEach(() => {
  document.documentElement.setAttribute('data-mantine-color-scheme', 'light');
});

describe('shell design-system markup: the cascade under it is the real one', () => {
  test('the app cascade, including the design-system layer, is loaded', async () => {
    await renderShell({ ds: true, scheme: 'light', viewport: DESKTOP });
    const evidence = cascadeEvidence();
    expect(evidence.tailwindFlexUtilityResolves).toBe(true);
    expect(evidence.layerOrder.declaredOrder).toEqual([
      'tailwind-preflight',
      'theme',
      'mantine',
      'civitai.components',
      'modules',
    ]);
    // Positive control for the design-system sheet itself: `inline-flex` comes ONLY from
    // `[data-civitai-ui='button']` (Mantine's button is `inline-block`, the theme layer sets no
    // display), so this is false if the sheet failed to load or lost its layer.
    const tos = document.querySelector<HTMLElement>('footer a[href="/content/tos"]');
    expect(tos?.getAttribute('data-civitai-ui')).toBe('button');
    expect(getComputedStyle(tos as HTMLElement).alignItems).toBe('center');
    expect(getComputedStyle(tos as HTMLElement).gap).toBe('8px');
  });
});

describe('shell design-system markup: flag ON matches flag OFF', () => {
  const MATRIX = [
    ['light', DESKTOP],
    ['dark', DESKTOP],
    ['light', PHONE],
    ['dark', PHONE],
  ] as const;

  test.each(MATRIX)('%s at %o: every control looks and behaves identically', async (scheme, vp) => {
    await renderShell({ ds: false, scheme, viewport: vp });
    const off = await capture();
    const offStates = [];
    for (const el of representatives()) offStates.push(await interactive(el));
    await cleanup();

    await renderShell({ ds: true, scheme, viewport: vp });
    const on = await capture();
    const onStates = [];
    for (const el of representatives()) onStates.push(await interactive(el));

    // Premises, so a green below is about the thing it claims to compare.
    // OFF really is the Mantine shell and ON really is the design-system shell…
    expect(off.dsRoots).toBe(0);
    expect(off.mantineRoots.length).toBeGreaterThan(20);
    expect(on.dsRoots).toBeGreaterThan(20);
    // …with nothing Mantine left in it but the sub-nav's More MENU trigger, which is a Mantine
    // `Menu.Target` and stays on Mantine by design.
    expect(on.mantineRoots).toEqual(['More']);

    // Same controls, same order, same names / hrefs / target / rel / aria / type / title.
    expect(on.semantics).toEqual(off.semantics);
    expect(on.semantics.length).toBeGreaterThan(20);

    // Same boxes, same content placement, same computed styles — control by control, so a
    // failure names the control that moved.
    on.looks.forEach((l, i) => {
      expect(l, `control ${i}: ${JSON.stringify(on.semantics[i])}`).toEqual(off.looks[i]);
    });
    expect(on.layout).toEqual(off.layout);

    // Hover and focus on one control of each kind.
    expect(onStates).toEqual(offStates);
  });

  test('the colour scheme really changes what is compared (control for the dark rows)', async () => {
    await renderShell({ ds: true, scheme: 'light', viewport: DESKTOP });
    const light = look(document.querySelector<HTMLElement>('a[href^="/login"]') as HTMLElement);
    await cleanup();
    await renderShell({ ds: true, scheme: 'dark', viewport: DESKTOP });
    const dark = look(document.querySelector<HTMLElement>('a[href^="/login"]') as HTMLElement);
    // `--mantine-color-default` is white in light and dark-6 in dark.
    expect(light.style['background-color']).not.toBe(dark.style['background-color']);
    expect(light.style['color']).not.toBe(dark.style['color']);
  });

  test('hover is observable in this harness (control for the hover comparison)', async () => {
    await renderShell({ ds: true, scheme: 'light', viewport: DESKTOP });
    const tos = document.querySelector<HTMLElement>('footer a[href="/content/tos"]') as HTMLElement;
    const before = getComputedStyle(tos).backgroundColor;
    const { hover } = await interactive(tos);
    expect(before).toBe('rgba(0, 0, 0, 0)');
    expect(hover.bg).not.toBe(before);
  });

  test.each(['light', 'dark'] as const)(
    'signed in (%s): the vertical divider and the header row match',
    async (scheme) => {
      state.user = { id: 1, username: 'tester' };
      await renderShell({ ds: false, scheme, viewport: DESKTOP });
      const off = layoutBoxes();
      await cleanup();
      await renderShell({ ds: true, scheme, viewport: DESKTOP });
      const on = layoutBoxes();
      expect(off.divider).not.toBeNull();
      // ON really renders the replacement, so the comparison is not Mantine against Mantine.
      expect(shellRoot().querySelector('header .mantine-Divider-root')).toBeNull();
      expect(shellRoot().querySelector('header .mantine-Grid-root')).toBeNull();
      expect(on.divider).toEqual(off.divider);
      expect(on).toEqual(off);
    }
  );

  test('live on Twitch: the red filled icon and its title match', async () => {
    state.live = true;
    await renderShell({ ds: false, scheme: 'dark', viewport: DESKTOP });
    const twitch = () => document.querySelector<HTMLElement>('a[href="/twitch"]') as HTMLElement;
    const off = { look: look(twitch()), semantics: semantics(twitch()) };
    await cleanup();
    await renderShell({ ds: true, scheme: 'dark', viewport: DESKTOP });
    const on = { look: look(twitch()), semantics: semantics(twitch()) };
    expect(off.semantics.title).toBe('Live now!');
    expect(twitch().getAttribute('data-civitai-ui')).toBe('button');
    expect(on).toEqual(off);
  });
});

describe('shell design-system markup: the literal contract', () => {
  test('footer links: name, href, target, rel and design-system attributes', async () => {
    await renderShell({ ds: true, scheme: 'dark', viewport: DESKTOP });
    const expected: Array<[string, string, string | null, string | null]> = [
      ['Terms of Service', '/content/tos', null, null],
      ['Privacy', '/content/privacy', null, null],
      ['Safety', '/safety', null, null],
      ['API', 'https://developer.civitai.com/', '_blank', 'nofollow noreferrer'],
      ['Status', 'https://status.civitai.com', '_blank', 'nofollow noreferrer'],
      ['Known Issues', '/issues', null, null],
      ['Creators', '/creator-program', null, null],
      ['Advertise', 'https://advertising.civitai.com', '_blank', 'nofollow noreferrer'],
    ];
    for (const [name, href, target, rel] of expected) {
      const el = page.getByRole('link', { name, exact: true }).element() as HTMLElement;
      expect(el.closest('footer'), name).not.toBeNull();
      expect(el.getAttribute('href'), name).toBe(href);
      expect(el.getAttribute('target'), name).toBe(target);
      expect(el.getAttribute('rel'), name).toBe(rel);
      expect(el.getAttribute('data-civitai-ui'), name).toBe('button');
      expect(el.getAttribute('data-variant'), name).toBe('subtle');
      expect(el.getAttribute('data-size'), name).toBe('sm');
    }
    // No 2257 link off the red domain.
    expect(document.querySelector('a[href="/content/2257"]')).toBeNull();
  });

  test('footer buttons: consent links and scroll-to-top', async () => {
    await renderShell({ ds: true, scheme: 'light', viewport: DESKTOP });
    for (const name of ['Manage cookies', 'Privacy Preferences']) {
      const el = page.getByRole('button', { name, exact: true }).element() as HTMLElement;
      expect(el.tagName, name).toBe('BUTTON');
      expect(el.getAttribute('type'), name).toBe('button');
      expect(el.getAttribute('data-civitai-ui'), name).toBe('button');
      expect(el.getAttribute('data-variant'), name).toBe('subtle');
      expect(el.getAttribute('data-size'), name).toBe('sm');
    }
    const top = page.getByRole('button', { name: 'Scroll to top', exact: true }).element();
    expect(top.getAttribute('type')).toBe('button');
    expect(top.getAttribute('data-civitai-ui')).toBe('button');
    expect(top.getAttribute('data-variant')).toBe('filled');
    expect(top.getAttribute('data-size')).toBe('md');
  });

  test('social links: eight labelled icon links opening in a new tab', async () => {
    await renderShell({ ds: true, scheme: 'dark', viewport: DESKTOP });
    const expected = [
      ['Civitai on Discord', '/discord'],
      ['Civitai on X', '/twitter'],
      ['Civitai on Instagram', '/instagram'],
      ['Civitai on YouTube', '/youtube'],
      ['Civitai on TikTok', '/tiktok'],
      ['Civitai on Reddit', '/reddit'],
      ['Civitai on GitHub', '/github'],
      ['Civitai on Twitch', '/twitch'],
    ];
    const rendered = [
      ...document.querySelectorAll<HTMLElement>('footer a[aria-label^="Civitai on"]'),
    ];
    expect(rendered.map((a) => [a.getAttribute('aria-label'), a.getAttribute('href')])).toEqual(
      expected
    );
    for (const [name] of expected) {
      const el = page.getByRole('link', { name, exact: true }).element() as HTMLElement;
      expect(el.getAttribute('target'), name).toBe('_blank');
      expect(el.getAttribute('rel'), name).toBe('nofollow noreferrer');
      expect(el.getAttribute('title'), name).toBeNull();
      expect(el.getAttribute('data-civitai-ui'), name).toBe('button');
      expect(el.getAttribute('data-variant'), name).toBe('subtle');
      expect(el.getAttribute('data-size'), name).toBe('md');
      expect(el.querySelector('svg'), name).not.toBeNull();
    }
  });

  test('social links: Twitch turns filled with a title while live', async () => {
    state.live = true;
    await renderShell({ ds: true, scheme: 'dark', viewport: DESKTOP });
    const el = page.getByRole('link', { name: 'Civitai on Twitch', exact: true }).element();
    expect(el.getAttribute('title')).toBe('Live now!');
    // Mantine's ActionIcon emits `data-variant="filled"` too; this is what separates the two.
    expect(el.getAttribute('data-civitai-ui')).toBe('button');
    expect(el.getAttribute('data-variant')).toBe('filled');
    // The other seven are unaffected.
    expect(document.querySelectorAll('footer a[data-variant="filled"]')).toHaveLength(1);
  });

  test('header, signed out: Sign In at desktop, the search icon on a phone', async () => {
    await renderShell({ ds: true, scheme: 'light', viewport: DESKTOP });
    const signIn = page.getByRole('link', { name: 'Sign In', exact: true }).element();
    expect(signIn.getAttribute('href')).toBe('/login?returnUrl=/');
    expect(signIn.getAttribute('rel')).toBe('nofollow');
    expect(signIn.getAttribute('target')).toBeNull();
    expect(signIn.getAttribute('data-civitai-ui')).toBe('button');
    expect(signIn.getAttribute('data-variant')).toBe('outline');
    expect(signIn.getAttribute('data-size')).toBe('md');
    await cleanup();

    await renderShell({ ds: true, scheme: 'light', viewport: PHONE });
    const search = page.getByRole('button', { name: 'Search', exact: true }).element();
    expect(search.getAttribute('type')).toBe('button');
    expect(search.getAttribute('data-civitai-ui')).toBe('button');
    expect(search.getAttribute('data-variant')).toBe('subtle');
    expect(search.getAttribute('data-size')).toBe('sm');
  });

  test('sub-nav pills: default-variant links, More stays a Mantine menu trigger', async () => {
    await renderShell({ ds: true, scheme: 'light', viewport: DESKTOP });
    const home = page.getByRole('link', { name: /^home$/i }).element();
    expect(home.getAttribute('href')).toBe('/');
    const models = page.getByRole('link', { name: /^models$/i }).element();
    expect(models.getAttribute('href')).toBe('/models');
    const row = models.parentElement as HTMLElement;
    const pills = [...row.querySelectorAll<HTMLElement>(':scope > a')];
    expect(pills.length).toBeGreaterThan(5);
    for (const pill of pills) {
      expect(pill.getAttribute('data-civitai-ui'), pill.textContent ?? '').toBe('button');
      expect(pill.getAttribute('data-variant'), pill.textContent ?? '').toBe('outline');
      expect(pill.getAttribute('data-size'), pill.textContent ?? '').toBe('md');
    }
    const more = [...row.querySelectorAll('button')].find((b) => b.textContent?.includes('More'));
    expect(more?.classList.contains('mantine-Button-root')).toBe(true);
  });

  test('flag OFF still renders the Mantine shell', async () => {
    await renderShell({ ds: false, scheme: 'light', viewport: DESKTOP });
    expect(document.querySelectorAll('[data-civitai-ui]')).toHaveLength(0);
    const tos = page.getByRole('link', { name: 'Terms of Service', exact: true }).element();
    expect(tos.classList.contains('mantine-Button-root')).toBe(true);
    const discord = page.getByRole('link', { name: 'Civitai on Discord', exact: true }).element();
    expect(discord.classList.contains('mantine-ActionIcon-root')).toBe(true);
    const signIn = page.getByRole('link', { name: 'Sign In', exact: true }).element();
    expect(signIn.classList.contains('mantine-Button-root')).toBe(true);
    expect(shellRoot().querySelector('header .mantine-Grid-root')).not.toBeNull();
  });
});
