// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ pathname: '/articles', viewerId: 1 as number | undefined }));
vi.mock('next/router', () => ({
  useRouter: () => ({ pathname: h.pathname, asPath: '/articles/7', push: vi.fn() }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => (h.viewerId ? { id: h.viewerId, isModerator: false } : null),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => ({}) }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy(),
}));
// The menu drawn flat, so what it holds is in the DOM without driving Mantine's open state.
vi.mock('@mantine/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantine/core')>();
  const pass = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  const Menu = Object.assign(pass, {
    Target: pass,
    Dropdown: pass,
    Label: pass,
    Divider: () => null,
    Item: ({ children }: { children?: React.ReactNode }) =>
      React.createElement('button', null, children),
  });
  return { ...actual, Menu };
});
vi.mock('~/hooks/useRescanArticle', () => ({ useRescanArticle: () => ({}) }));
// The items under test stand in as markers: their own gating is tested with them.
vi.mock('~/components/Decorations/AddEventDecorationMenuItem', () => ({
  AddEventDecorationMenuItem: (p: { entityType: string; entityId: number }) =>
    React.createElement('div', { 'data-testid': `hat-item:${p.entityType}:${p.entityId}` }),
}));
vi.mock('~/components/Decorations/AddArtFrameMenuItem', () => ({
  AddArtFrameMenuItem: () => React.createElement('div', { 'data-testid': 'frame-item' }),
}));
vi.mock('~/components/MenuItems/ToggleSearchableMenuItem', () => ({
  ToggleSearchableMenuItem: () => null,
}));

const { ArticleContextMenu } = await import('~/components/Article/ArticleContextMenu');

type Article = React.ComponentProps<typeof ArticleContextMenu>['article'];
const ARTICLE = {
  id: 7,
  status: 'Published',
  user: { id: 1 },
  coverImage: { id: 42, url: 'img-42' },
} as unknown as Article;

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});
beforeEach(() => {
  h.pathname = '/articles';
  h.viewerId = 1;
});

function openMenu(article: Article = ARTICLE) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(ArticleContextMenu, { article })
      )
    )
  );
  const ids = [...document.body.querySelectorAll('[data-testid]')].map((el) =>
    el.getAttribute('data-testid')
  );
  return ids.filter((id) => id === 'frame-item' || id?.startsWith('hat-item'));
}

describe('article menu hat item', () => {
  it("offers the owner a hat for the article on the article's own page, without the frame", () => {
    h.pathname = '/articles/[id]/[[...slug]]';
    expect(openMenu()).toEqual(['hat-item:Article:7']);
  });

  it('offers the owner both on a card', () => {
    expect(openMenu()).toEqual(['frame-item', 'hat-item:Article:7']);
  });

  it('offers neither to someone else, nor for an article without a cover', () => {
    h.pathname = '/articles/[id]/[[...slug]]';
    h.viewerId = 2;
    expect(openMenu()).toEqual([]);
    act(() => root?.unmount());
    h.viewerId = 1;
    expect(openMenu({ ...ARTICLE, coverImage: null } as unknown as Article)).toEqual([]);
  });
});
