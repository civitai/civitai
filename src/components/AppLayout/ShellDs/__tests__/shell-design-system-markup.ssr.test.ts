// @vitest-environment happy-dom
/**
 * The footer's SERVER-RENDERED markup with `shellDesignSystemMarkup` ON and OFF.
 *
 * Server render is the path the flag exists for (it removes Mantine's per-instance style work from
 * every page's SSR), and this tier is the one that gates a pull request — the pixel comparison in
 * `shellDesignSystemMarkup.geometry.test.tsx` runs in a tier that only informs on PRs. So the
 * contract a user and assistive technology depend on is pinned here as literals: every link's
 * name, href, target and rel, the design-system attributes, and the absence of Mantine's button
 * classes when ON / their presence when OFF.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as BrowsingAddonsModule from '~/providers/BrowsingSettingsAddonsProvider';
import type * as ConsentModule from '~/components/Consent/consent.context';

const state = vi.hoisted(() => ({ ds: false, live: false }));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({
    safety: true,
    bugsPage: true,
    isRed: false,
    shellDesignSystemMarkup: state.ds,
  }),
}));
vi.mock('~/hooks/useDomainColor', () => ({ useDomainColor: () => 'green' }));
vi.mock('~/hooks/useIsLive', () => ({ useIsLive: () => state.live }));
vi.mock('~/components/ScrollArea/ScrollAreaContext', () => ({
  useScrollAreaRef: () => ({ current: null }),
}));
vi.mock('~/providers/BrowsingSettingsAddonsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingAddonsModule>()),
  useBrowsingSettingsAddons: () => ({ settings: { excludedFooterLinks: [] } }),
}));
vi.mock('~/components/Consent/consent.context', async (importOriginal) => ({
  ...(await importOriginal<typeof ConsentModule>()),
  useThirdPartyConsent: () => ({ required: true, reset: () => undefined }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof TrpcModule>()), trpc: makeTrpcProxy() };
});
// A Mantine `Menu` and a client-only button; both stay on Mantine whatever the flag says.
vi.mock('~/components/Support/SupportMenu', () => ({ SupportMenu: () => null }));
vi.mock('~/components/Assistant/AssistantButton', () => ({ AssistantButton: () => null }));

const { AppFooter } = await import('~/components/AppLayout/AppFooter');

function renderFooter(): Document {
  const html = renderToStaticMarkup(
    React.createElement(MantineProvider, null, React.createElement(AppFooter))
  );
  return new DOMParser().parseFromString(html, 'text/html');
}

const MANTINE_BUTTON_CLASSES = ['mantine-Button-root', 'mantine-ActionIcon-root'];

function attrs(el: Element) {
  return {
    text: (el.textContent ?? '').trim(),
    href: el.getAttribute('href'),
    target: el.getAttribute('target'),
    rel: el.getAttribute('rel'),
    ariaLabel: el.getAttribute('aria-label'),
    title: el.getAttribute('title'),
    type: el.getAttribute('type'),
  };
}

beforeEach(() => {
  state.ds = false;
  state.live = false;
});

describe('AppFooter server render, shellDesignSystemMarkup ON', () => {
  it('renders every footer link as a design-system subtle button link', () => {
    state.ds = true;
    const doc = renderFooter();
    const links = [...doc.querySelectorAll('footer a:not([aria-label])')].map((a) => ({
      ...attrs(a),
      ui: a.getAttribute('data-civitai-ui'),
      variant: a.getAttribute('data-variant'),
      size: a.getAttribute('data-size'),
    }));
    const ds = { ui: 'button', variant: 'subtle', size: 'sm', ariaLabel: null, title: null };
    const blank = { target: '_blank', rel: 'nofollow noreferrer', type: null };
    const local = { target: null, rel: null, type: null };
    expect(links).toEqual([
      { text: 'Terms of Service', href: '/content/tos', ...local, ...ds },
      { text: 'Privacy', href: '/content/privacy', ...local, ...ds },
      { text: 'Safety', href: '/safety', ...local, ...ds },
      { text: 'API', href: 'https://developer.civitai.com/', ...blank, ...ds },
      { text: 'Status', href: 'https://status.civitai.com', ...blank, ...ds },
      { text: 'Known Issues', href: '/issues', ...local, ...ds },
      { text: 'Creators', href: '/creator-program', ...local, ...ds },
      { text: 'Advertise', href: 'https://advertising.civitai.com', ...blank, ...ds },
    ]);
  });

  it('renders the eight social links as labelled design-system icon links', () => {
    state.ds = true;
    const doc = renderFooter();
    const social = [...doc.querySelectorAll('footer a[aria-label]')].map((a) => ({
      label: a.getAttribute('aria-label'),
      href: a.getAttribute('href'),
      target: a.getAttribute('target'),
      rel: a.getAttribute('rel'),
      title: a.getAttribute('title'),
      ui: a.getAttribute('data-civitai-ui'),
      variant: a.getAttribute('data-variant'),
      size: a.getAttribute('data-size'),
      icon: a.querySelectorAll('svg').length,
    }));
    const common = {
      target: '_blank',
      rel: 'nofollow noreferrer',
      title: null,
      ui: 'button',
      variant: 'subtle',
      size: 'md',
      icon: 1,
    };
    expect(social).toEqual([
      { label: 'Civitai on Discord', href: '/discord', ...common },
      { label: 'Civitai on X', href: '/twitter', ...common },
      { label: 'Civitai on Instagram', href: '/instagram', ...common },
      { label: 'Civitai on YouTube', href: '/youtube', ...common },
      { label: 'Civitai on TikTok', href: '/tiktok', ...common },
      { label: 'Civitai on Reddit', href: '/reddit', ...common },
      { label: 'Civitai on GitHub', href: '/github', ...common },
      { label: 'Civitai on Twitch', href: '/twitch', ...common },
    ]);
  });

  it('marks Twitch live with a filled variant and the same title as before', () => {
    state.ds = true;
    state.live = true;
    const twitch = renderFooter().querySelector('a[href="/twitch"]');
    expect(twitch?.getAttribute('title')).toBe('Live now!');
    expect(twitch?.getAttribute('data-variant')).toBe('filled');
    // Mantine's ActionIcon also emits `data-variant="filled"`, so the line above alone cannot tell
    // the two footers apart.
    expect(twitch?.getAttribute('data-civitai-ui')).toBe('button');
  });

  // `PrivacyPreferencesFooterLink` is absent from every server render, whatever the flag: its
  // zustand store answers React's SERVER snapshot (the initial `visible: false`) during SSR, and
  // the CMP only flips it on the client. The geometry test covers it, rendering on the client.
  it('renders the consent link and scroll-to-top as native design-system buttons', () => {
    state.ds = true;
    const buttons = [...renderFooter().querySelectorAll('footer button')].map((b) => ({
      ...attrs(b),
      ui: b.getAttribute('data-civitai-ui'),
      variant: b.getAttribute('data-variant'),
      size: b.getAttribute('data-size'),
    }));
    const none = { href: null, target: null, rel: null, title: null, type: 'button', ui: 'button' };
    expect(buttons).toEqual([
      { text: '', ariaLabel: 'Scroll to top', ...none, variant: 'filled', size: 'md' },
      { text: 'Manage cookies', ariaLabel: null, ...none, variant: 'subtle', size: 'sm' },
    ]);
  });

  it('renders no Mantine Button or ActionIcon and no Mantine Text', () => {
    state.ds = true;
    const doc = renderFooter();
    for (const cls of [...MANTINE_BUTTON_CLASSES, 'mantine-Text-root'])
      expect(doc.getElementsByClassName(cls), cls).toHaveLength(0);
    // Control: the selector machinery sees the design-system buttons it is replacing them with.
    expect(doc.querySelectorAll('[data-civitai-ui="button"]')).toHaveLength(18);
    const copyright = doc.querySelector('footer p');
    expect(copyright?.textContent).toBe(`© Civitai ${new Date().getFullYear()}`);
  });
});

describe('AppFooter server render, shellDesignSystemMarkup OFF', () => {
  it('still renders the Mantine footer, with the same links', () => {
    const doc = renderFooter();
    expect(doc.querySelectorAll('[data-civitai-ui]')).toHaveLength(0);
    expect(doc.getElementsByClassName('mantine-Button-root')).toHaveLength(10);
    expect(doc.getElementsByClassName('mantine-ActionIcon-root')).toHaveLength(8);
    expect(doc.getElementsByClassName('mantine-Text-root')).toHaveLength(1);
    const tos = doc.querySelector('footer a[href="/content/tos"]');
    expect(tos?.classList.contains('mantine-Button-root')).toBe(true);
    const discord = doc.querySelector('footer a[href="/discord"]');
    expect(discord?.classList.contains('mantine-ActionIcon-root')).toBe(true);
  });

  it('exposes the same names, hrefs, targets and rels as the flag-ON footer', () => {
    const controls = (doc: Document) =>
      [...doc.querySelectorAll('footer a, footer button')].map(attrs);
    const off = controls(renderFooter());
    state.ds = true;
    const on = controls(renderFooter());
    expect(off).toHaveLength(18);
    expect(on).toEqual(off);
  });
});
