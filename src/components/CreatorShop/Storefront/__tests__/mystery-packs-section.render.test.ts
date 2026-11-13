// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

/**
 * The storefront's Mystery packs section is for viewers with every creator pack flag: without
 * them it renders nothing AND asks the server for nothing, and with them it asks for the read
 * that matches whether the viewer is signed in.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { state, record } = vi.hoisted(() => {
  const state = {
    flags: {} as Record<string, boolean>,
    user: null as { id: number } | null,
    asked: [] as { query: string; enabled: boolean | undefined }[],
  };
  const record = (query: string) => (_: unknown, opts?: { enabled?: boolean }) => {
    state.asked.push({ query, enabled: opts?.enabled });
    return { data: undefined };
  };
  return { state, record };
});

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'mysteryBox.getForSeller': { useQuery: record('getForSeller') },
    'mysteryBox.getForCreator': { useQuery: record('getForCreator') },
  }),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => state.flags }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.user }));

import { MysteryPacksSection } from '../MysteryPacksSection';

const ALL_FLAGS = {
  creatorShop: true,
  cosmeticPacks: true,
  mysteryBox: true,
  creatorMysteryPacks: true,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const render = () =>
  act(async () =>
    root.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(MysteryPacksSection, { ownerUserId: 77 })
      )
    )
  );
const enabledQueries = () => state.asked.filter((q) => q.enabled).map((q) => q.query);

beforeEach(() => {
  state.asked = [];
  state.user = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('MysteryPacksSection', () => {
  it.each(Object.keys(ALL_FLAGS))('asks for nothing and shows nothing without %s', async (flag) => {
    state.flags = { ...ALL_FLAGS, [flag]: false };
    state.user = { id: 5 };
    await render();
    expect(enabledQueries()).toEqual([]);
    expect(container.querySelector('[data-testid="mystery-packs-section"]')).toBeNull();
  });

  it('reads the viewer-aware packs when signed in, and the public catalog when signed out', async () => {
    state.flags = ALL_FLAGS;
    state.user = { id: 5 };
    await render();
    expect(enabledQueries()).toEqual(['getForSeller']);

    state.asked = [];
    state.user = null;
    await render();
    expect(enabledQueries()).toEqual(['getForCreator']);
  });
});
