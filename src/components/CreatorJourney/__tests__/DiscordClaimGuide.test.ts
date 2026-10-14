// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import type * as Trpc from '~/utils/trpc';
import type * as DialogProviderModule from '~/components/Dialog/DialogProvider';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import {
  discordClaimGuideFromQuery,
  discordClaimGuideHref,
  discordRoleRewards,
} from '~/components/CreatorJourney/discord-claim-guide';
import { DiscordClaimGuideModal } from '~/components/CreatorJourney/DiscordClaimGuideModal';
import { CreatorJourney } from '~/components/CreatorJourney/CreatorJourney';
import { tierRewards } from '~/components/CreatorJourney/tier-rewards';

const router = vi.hoisted(() => ({
  isReady: true,
  pathname: '/creators/journey',
  query: {} as Record<string, string | string[]>,
  replace: vi.fn(),
}));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const original = await importOriginal<typeof Trpc>();
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...original,
    trpc: makeTrpcProxy({
      'creatorJourney.getMine': { useQuery: () => ({ isLoading: true, data: undefined }) },
    }),
  };
});
// The modal reads `opened` from the dialog it is rendered in; outside one it would stay closed.
vi.mock('~/components/Dialog/DialogProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof DialogProviderModule>()),
  useDialogContext: () => ({ opened: true, onClose: () => undefined }),
}));

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function render(element: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(React.createElement(MantineProvider, null, element)));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = '';
  useDialogStore.getState().closeAll();
  router.query = {};
  router.isReady = true;
  router.replace.mockReset();
});

const openDialogs = () => useDialogStore.getState().dialogs;

describe('discordClaimGuideFromQuery', () => {
  it('reads a known tier and refuses anything else', () => {
    expect(discordClaimGuideFromQuery('legend')).toBe('legend');
    expect(discordClaimGuideFromQuery('supernova')).toBe('supernova');
    expect(discordClaimGuideFromQuery('star')).toBeNull();
    expect(discordClaimGuideFromQuery('Legend')).toBeNull();
    expect(discordClaimGuideFromQuery(['legend', 'legend'])).toBeNull();
    expect(discordClaimGuideFromQuery(undefined)).toBeNull();
  });

  it('round-trips the href it gives out', () => {
    const href = discordClaimGuideHref('legend');
    expect(href).toBe('/creators/journey?discord=legend');
    const url = new URL(href, 'https://civitai.com');
    expect(discordClaimGuideFromQuery(url.searchParams.get('discord') ?? undefined)).toBe('legend');
  });

  it('lists each Discord role line among its tier rewards', () => {
    for (const [tierKey, { line }] of Object.entries(discordRoleRewards))
      expect(tierRewards[tierKey]).toContain(line);
  });
});

describe('the deep link', () => {
  it('opens the guide for the tier in the query, and drops only that param on close', () => {
    router.query = { discord: 'legend', ref: 'dm' };
    render(React.createElement(CreatorJourney));
    expect(openDialogs().map((d) => [d.id, d.props])).toEqual([
      ['discord-claim-guide', { tier: 'legend' }],
    ]);

    openDialogs()[0].options?.onClose?.();
    expect(router.replace).toHaveBeenCalledWith(
      { pathname: '/creators/journey', query: { ref: 'dm' } },
      undefined,
      { shallow: true }
    );
  });

  it('opens nothing for an unknown tier or before the router is ready', () => {
    router.query = { discord: 'star' };
    render(React.createElement(CreatorJourney));
    expect(openDialogs()).toEqual([]);
    act(() => root?.unmount());

    router.query = { discord: 'legend' };
    router.isReady = false;
    render(React.createElement(CreatorJourney));
    expect(openDialogs()).toEqual([]);
  });
});

describe('DiscordClaimGuideModal', () => {
  const links = () =>
    [...document.body.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);

  it('links Discord, then the server, and names #legends for a Legend', () => {
    render(React.createElement(DiscordClaimGuideModal, { tier: 'legend' }));
    expect(links()).toEqual([
      ['Link Discord', '/discord/link-role'],
      ['Join the server', 'https://discord.gg/civitai'],
    ]);
    const steps = [...document.body.querySelectorAll('ol > li')].map((li) => li.textContent);
    expect(steps).toHaveLength(4);
    expect(steps[2]).toContain('within 6 hours');
    expect(steps[3]).toContain('#legends');
  });

  it('leaves #legends out for a Supernova', () => {
    render(React.createElement(DiscordClaimGuideModal, { tier: 'supernova' }));
    expect(document.body.querySelectorAll('ol > li')).toHaveLength(3);
    expect(document.body.textContent).not.toContain('#legends');
    expect(document.body.textContent).toContain('Supernova role');
  });
});
