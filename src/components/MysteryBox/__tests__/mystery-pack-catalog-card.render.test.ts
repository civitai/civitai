// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { act } = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 5 }) }));
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: React.ReactElement }) => children,
}));
vi.mock('~/components/NextLink/NextLink', () => ({
  NextLink: React.forwardRef<HTMLAnchorElement, { href: string }>(function NextLink(props, ref) {
    return React.createElement('a', { ...props, ref });
  }),
}));

import { MysteryBoxCatalogCard } from '../MysteryBoxCatalogCard';
import type { MysteryBoxCatalogView } from '../mystery-box.utils';

const box = (seller?: { id: number; username: string | null }) =>
  ({
    boxDefinitionId: 9,
    name: 'Neon Night Pack',
    description: null,
    unitAmount: 650,
    pack: null,
    tiers: [
      { id: 1, key: 'common', name: 'Common', color: null, weight: 8000, sortOrder: 0 },
      { id: 2, key: 'rare', name: 'Rare', color: null, weight: 2000, sortOrder: 1 },
    ],
    contents: [
      { contentId: 1, tierId: 1, team: null },
      { contentId: 2, tierId: 2, team: null },
    ],
    teams: [],
    seller,
  } as MysteryBoxCatalogView & { seller?: { id: number; username: string | null } });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const render = (view: ReturnType<typeof box>) =>
  act(async () =>
    root.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(MysteryBoxCatalogCard, { box: view })
      )
    )
  );
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('MysteryBoxCatalogCard for a creator pack', () => {
  it('names its seller and links to their shop instead of asking the viewer to join a team', async () => {
    await render(box({ id: 77, username: 'testcreator' }));
    expect(container.textContent).toContain('Sold by @testcreator');
    expect(
      container.querySelector('[data-testid="box-catalog-shop-link"]')?.getAttribute('href')
    ).toBe('/user/testcreator/shop');
    expect(container.querySelector('[data-testid="box-catalog-join"]')).toBeNull();
  });

  it('still asks a viewer to join a team for a team box', async () => {
    await render(box());
    expect(container.querySelector('[data-testid="box-catalog-join"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="box-catalog-shop-link"]')).toBeNull();
    expect(container.textContent).not.toContain('Sold by');
  });
});
