// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import type * as MantineCore from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

const { act } = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  pathname: '/articles',
  viewerId: 1 as number | undefined,
  isModerator: false,
}));
vi.mock('next/router', () => ({
  useRouter: () => ({ pathname: h.pathname, asPath: '/articles/7', push: vi.fn() }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => (h.viewerId ? { id: h.viewerId, isModerator: h.isModerator } : null),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => ({}) }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy(),
}));
// The menu drawn flat, so what it holds is in the DOM without driving Mantine's open state.
vi.mock('@mantine/core', async (importOriginal) => {
  const actual = await importOriginal<typeof MantineCore>();
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
vi.mock('~/components/Decorations/AddEventDecorationMenuItem', () => ({
  AddEventDecorationMenuItem: () => null,
}));
vi.mock('~/components/Decorations/AddArtFrameMenuItem', () => ({
  AddArtFrameMenuItem: () => null,
}));
vi.mock('~/components/MenuItems/ToggleSearchableMenuItem', () => ({
  ToggleSearchableMenuItem: () => null,
}));
// Its own picker logic is tested in AddToShowcaseModal.browser.test.tsx.
vi.mock('~/components/Profile/AddToShowcaseMenuItem', () => ({
  AddToShowcaseMenuItem: (p: { entityType: string; entityId: number }) =>
    React.createElement('div', { 'data-testid': `showcase-item:${p.entityType}:${p.entityId}` }),
}));

const { ArticleContextMenu } = await import('~/components/Article/ArticleContextMenu');

type Article = React.ComponentProps<typeof ArticleContextMenu>['article'];
const ARTICLE = { id: 7, status: 'Published', user: { id: 1 } } as unknown as Article;

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});
beforeEach(() => {
  h.pathname = '/articles';
  h.viewerId = 1;
  h.isModerator = false;
});

function showcaseItems(article: Article = ARTICLE) {
  act(() => root?.unmount());
  host?.remove();
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
  return [...document.body.querySelectorAll('[data-testid^="showcase-item"]')].map((el) =>
    el.getAttribute('data-testid')
  );
}

describe('article menu Add to Showcase', () => {
  it.each(['/articles', '/articles/[id]/[[...slug]]'])(
    'offers the owner of a published article the item on %s',
    (pathname) => {
      h.pathname = pathname;
      expect(showcaseItems()).toEqual(['showcase-item:Article:7']);
    }
  );

  it('offers it to nobody else, a moderator included', () => {
    h.viewerId = 2;
    expect(showcaseItems()).toEqual([]);
    h.isModerator = true;
    expect(showcaseItems()).toEqual([]);
  });

  it.each(['Draft', 'Unpublished', 'UnpublishedViolation'])(
    'does not offer it for a %s article',
    (status) => {
      expect(showcaseItems({ ...ARTICLE, status } as unknown as Article)).toEqual([]);
    }
  );
});
