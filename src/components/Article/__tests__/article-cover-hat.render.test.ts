// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';
import { getHatLayout } from '~/components/Cosmetics/EventDecoration/event-decoration-placement';

const act = (React as unknown as { act: (callback: () => void) => void }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ shown: true }));
vi.mock('~/providers/BrowserSettingsProvider', () => ({ useShowEventCosmetics: () => h.shown }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy(),
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: () => React.createElement('img', { alt: '' }),
}));
// Stands in for the popover so the test can read what the hat says it is worn on.
vi.mock('~/components/Cosmetics/EventDecoration/WornHatPopover', () => ({
  WornHatPopover: (p: {
    wornOn: { entityType: string; entityId: number };
    children?: React.ReactNode;
  }) =>
    React.createElement(
      'div',
      { 'data-worn-on': `${p.wornOn.entityType}:${p.wornOn.entityId}` },
      p.children
    ),
}));

const { ArticleCoverHat } = await import('~/components/Article/ArticleCoverHat');

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  h.shown = true;
});

const HAT = '[data-event-decoration="hat"]';
const decoration = { data: { type: 'hat', event: 'birthday2026', url: 'u' } } as const;

function render(props: React.ComponentProps<typeof ArticleCoverHat>) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      React.createElement(MantineProvider, null, React.createElement(ArticleCoverHat, props))
    )
  );
  return host;
}

describe('ArticleCoverHat', () => {
  it("draws the article's hat inside the cover's top-left corner, worn on the article", () => {
    const el = render({ articleId: 7, decoration });
    const hat = el.querySelector<HTMLElement>(HAT);
    expect(hat).not.toBeNull();
    // `inside`: the cover's aspect-ratio box clips a `corner` hat, whose place is a calc().
    const inside = getHatLayout('inside', undefined, undefined, 0);
    expect(hat?.style.left).toMatch(/^[\d.]+px$/);
    expect(parseFloat(hat!.style.left)).toBeCloseTo(inside.left, 3);
    expect(parseFloat(hat!.style.top)).toBeCloseTo(inside.top, 3);
    expect(el.querySelector('[data-worn-on]')?.getAttribute('data-worn-on')).toBe('Article:7');
  });

  it('draws nothing when the article wears no hat', () => {
    expect(render({ articleId: 7, decoration: null }).querySelector(HAT)).toBeNull();
  });

  it('draws nothing when the viewer has event cosmetics off', () => {
    h.shown = false;
    expect(render({ articleId: 7, decoration }).querySelector(HAT)).toBeNull();
  });
});
