// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

/**
 * The box for a viewer not on a team, in the hat catalog an unjoined visitor sees: base odds, the
 * odds page, and what it takes to open one. Signed out that is signing in; signed in, joining.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { state } = vi.hoisted(() => ({
  state: {
    boxes: [] as unknown[],
    flags: { mysteryBox: true } as Record<string, boolean> | null,
    user: null as { id: number } | null,
  },
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'mysteryBox.getCatalogForEvent': {
      useQuery: (_: unknown, opts?: { enabled?: boolean }) => ({
        data: opts?.enabled === false ? undefined : state.boxes,
      }),
    },
    'event.getHatCatalog': {
      useQuery: () => ({
        data: [{ design: 'party', name: 'Party Hat', hats: [{ url: 'p.png', team: 'Blue' }] }],
      }),
    },
  }),
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useOptionalFeatureFlags: () => state.flags,
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.user }));
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: React.ReactElement }) =>
    React.createElement('div', { 'data-testid': 'login-redirect' }, children),
}));
vi.mock('~/components/NextLink/NextLink', () => ({
  NextLink: React.forwardRef<HTMLAnchorElement, { href: string }>(function NextLink(props, ref) {
    return React.createElement('a', { ...props, ref });
  }),
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ src }: { src: string }) => React.createElement('img', { 'data-src': src }),
}));
vi.mock('~/components/Events/events.utils', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTeamColor: () => () => '#339af0',
}));

import { HatCatalogPreview } from '~/components/Events/ScoredEvent/HatCatalogPreview';
import type { MysteryBoxCatalogView } from '../mystery-box.utils';

const COMMON = 7;
const RARE = 8;
const box = (overrides: Partial<MysteryBoxCatalogView> = {}): MysteryBoxCatalogView => ({
  boxDefinitionId: 9,
  name: 'Birthday Box',
  description: null,
  unitAmount: 500,
  tiers: [
    { id: COMMON, key: 'common', name: 'Common', color: null, weight: 3, sortOrder: 0 },
    { id: RARE, key: 'rare', name: 'Rare', color: null, weight: 1, sortOrder: 1 },
  ],
  contents: [
    { contentId: 1, tierId: COMMON, team: 'Blue' },
    { contentId: 2, tierId: COMMON, team: 'Pink' },
    { contentId: 3, tierId: RARE, team: 'Blue' },
    { contentId: 4, tierId: RARE, team: 'Pink' },
  ],
  teams: ['Blue', 'Pink'],
  ...overrides,
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const render = async (showBoxes?: boolean) => {
  await act(async () =>
    root.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(HatCatalogPreview, {
          event: 'birthday2026',
          onJoin: vi.fn(),
          joining: false,
          showBoxes,
        })
      )
    )
  );
};
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  state.boxes = [box()];
  state.flags = { mysteryBox: true };
  state.user = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('the mystery box in the hat catalog', () => {
  it('asks a signed-out visitor to sign in to open, and links the odds page', async () => {
    await render();

    const card = byTestId('mystery-box-catalog-card')!;
    expect(card.textContent).toContain('Birthday Box');
    expect(card.textContent).toContain('500 Buzz');
    expect(
      byTestId('box-catalog-sign-in')?.closest('[data-testid="login-redirect"]')
    ).not.toBeNull();
    expect(byTestId('box-catalog-join')).toBeNull();
    expect(byTestId('box-catalog-odds-link')?.getAttribute('href')).toBe('/mystery-boxes/9');
  });

  it('tells a signed-in viewer not on a team to join one', async () => {
    state.user = { id: 5 };
    await render();

    expect(byTestId('box-catalog-join')?.textContent).toBe(
      'Join a team to open boxes in your color.'
    );
    expect(byTestId('box-catalog-sign-in')).toBeNull();
  });

  it('shows the base odds every team shares, as a team member who owns nothing would see them', async () => {
    await render();

    const bar = byTestId('box-odds-bar')!;
    const labels = [...bar.querySelectorAll('[aria-label]')].map((s) =>
      s.getAttribute('aria-label')
    );
    expect(labels).toEqual(['Common 75%', 'Rare 25%']);
    expect(byTestId('box-odds-by-team')).toBeNull();
  });

  it('sends a viewer to the odds page when the odds differ by team', async () => {
    // Pink has nothing Rare, so a Pink draw is always Common.
    state.boxes = [box({ contents: box().contents.filter((c) => c.contentId !== 4) })];
    await render();

    expect(byTestId('box-odds-bar')).toBeNull();
    expect(byTestId('box-odds-by-team')).not.toBeNull();
  });

  it("waits to fetch the box until it's known the viewer is not on a team", async () => {
    await render(false);
    expect(byTestId('mystery-box-catalog-card')).toBeNull();
  });

  it('shows no box with the flag off', async () => {
    state.flags = { mysteryBox: false };
    await render();
    expect(byTestId('mystery-box-catalog-card')).toBeNull();
  });
});
