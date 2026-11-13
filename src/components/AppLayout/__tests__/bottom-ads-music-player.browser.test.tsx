import { act } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as AdhesiveAdModule from '~/components/Ads/AdhesiveAd';
import type * as AdUnitOutstreamModule from '~/components/Ads/AdUnitOutstream';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as IsMobile from '~/hooks/useIsMobile';
import type * as IsClient from '~/providers/IsClientProvider';
import type { MusicTrack } from '~/store/music-player.store';

const mocks = vi.hoisted(() => ({ user: undefined as Record<string, unknown> | undefined }));

vi.mock('~/components/Ads/AdhesiveAd', async (importOriginal) => ({
  ...(await importOriginal<typeof AdhesiveAdModule>()),
  AdhesiveAd: () => <div data-testid="adhesive-ad" />,
}));
vi.mock('~/components/Ads/AdUnitOutstream', async (importOriginal) => ({
  ...(await importOriginal<typeof AdUnitOutstreamModule>()),
  AdUnitOutstreamWithCloseButton: () => <div data-testid="outstream-ad" />,
}));
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => mocks.user,
}));
vi.mock('~/hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof IsMobile>()),
  useIsMobile: () => false,
}));
vi.mock('~/providers/IsClientProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof IsClient>()),
  useIsClient: () => true,
}));

import { AdhesiveFooter } from '~/components/AppLayout/AppLayout';
import { ChatPortal } from '~/components/Chat/ChatPortal';
import { useMusicPlayerStore } from '~/store/music-player.store';

const song: MusicTrack = {
  id: 1,
  url: 'song-key',
  title: 'Midnight Arcade',
  durationSec: 200,
  creator: { id: 2, username: 'neonwave' },
};

beforeEach(() => {
  mocks.user = { id: 7, isPaidMember: false };
  useMusicPlayerStore.getState().close();
});

describe('the adhesive footer ad and the music player', () => {
  test('shows the ad to a non-member when no song is playing', async () => {
    await renderWithProviders(<AdhesiveFooter />);
    await expect.element(page.getByTestId('adhesive-ad')).toBeInTheDocument();
  });

  test('hides while the player is active, and comes back when it closes', async () => {
    useMusicPlayerStore.getState().playTrack(song);
    await renderWithProviders(<AdhesiveFooter />);
    expect(page.getByTestId('adhesive-ad').elements()).toHaveLength(0);

    act(() => useMusicPlayerStore.getState().minimize());
    expect(page.getByTestId('adhesive-ad').elements()).toHaveLength(0);

    act(() => useMusicPlayerStore.getState().close());
    await expect.element(page.getByTestId('adhesive-ad')).toBeInTheDocument();
  });
});

describe('the bottom-left outstream ad and the music player', () => {
  test('shows on desktop when no song is playing', async () => {
    await renderWithProviders(<ChatPortal showFooter={false} />);
    await expect.element(page.getByTestId('outstream-ad')).toBeInTheDocument();
  });

  test('hides while the player is active, and comes back when it closes', async () => {
    useMusicPlayerStore.getState().playTrack(song);
    await renderWithProviders(<ChatPortal showFooter={false} />);
    expect(page.getByTestId('outstream-ad').elements()).toHaveLength(0);

    act(() => useMusicPlayerStore.getState().close());
    await expect.element(page.getByTestId('outstream-ad')).toBeInTheDocument();
  });
});
