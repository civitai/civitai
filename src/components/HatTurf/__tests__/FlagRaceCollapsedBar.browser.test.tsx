import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import type * as Trpc from '~/utils/trpc';
import type { FlagSummary } from '~/server/events/turf/turf.service';

import '~/styles/globals.css';

/** The home Flag Race row, shrunk to a bar, and the event page's way back once it is hidden. */

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy({
      'event.getData': { useQuery: () => ({ data: { teams: ['Green', 'Blue'] } }) },
    }),
  };
});

import { useNavBannersDismissed } from '~/components/AppLayout/NavAnnouncementSlot/nav-banners-dismissed';
import {
  FlagRaceCollapsedBar,
  flagRaceHomeKey,
} from '~/components/HatTurf/FlagRace/FlagRaceCollapsedBar';
import { ShowEventHomeBlock } from '~/components/HomeBlocks/ShowEventHomeBlock';
import {
  eventHomeBlockCollapseId,
  eventHomeBlockDismissId,
} from '~/components/HomeBlocks/scored-event-home-block.utils';
import { renderWithProviders } from '../../../../test/component-setup';

const EVENT = 'birthday2026';
const summary = ({ closed = false, pot = 1200 } = {}): FlagSummary =>
  ({
    flagDayId: 1,
    closed,
    cutAt: null,
    closesAt: new Date(Date.now() + 3_600_000),
    frozen: false,
    teamPoints: {},
    flags: [
      { imageId: 1, hatsByTeam: { Green: 3 }, players: 3, pot, winners: [] },
      { imageId: 2, hatsByTeam: { Blue: 1 }, players: 1, pot: 0, winners: [] },
    ],
    nextCrucible: null,
  } as unknown as FlagSummary);

afterEach(async () => {
  await cleanup();
});

describe('FlagRaceCollapsedBar', () => {
  test("leads with today's points, and Show and X do what they say", async () => {
    const onExpand = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(
      <FlagRaceCollapsedBar
        event={EVENT}
        summary={summary()}
        onExpand={onExpand}
        onClose={onClose}
      />
    );
    await expect.element(page.getByText('1.2k points up for grabs')).toBeInTheDocument();
    await expect.element(page.getByLabelText('Green holds 1 flag')).toBeInTheDocument();
    await userEvent.click(page.getByRole('button', { name: 'Show' }));
    expect(onExpand).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole('button', { name: 'Hide the Flag Race' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('a closed day says it is counting, not a stale pot', async () => {
    renderWithProviders(
      <FlagRaceCollapsedBar
        event={EVENT}
        summary={summary({ closed: true })}
        onExpand={() => undefined}
        onClose={() => undefined}
      />
    );
    await expect.element(page.getByText('Counting today’s flags')).toBeInTheDocument();
    expect(page.getByText(/points up for grabs/).query()).toBeNull();
  });
});

describe("the Flag Race's home entries", () => {
  function EventPage() {
    const { dismiss } = useNavBannersDismissed();
    const key = flagRaceHomeKey(EVENT);
    return (
      <>
        <button
          onClick={() => dismiss(eventHomeBlockDismissId(key), eventHomeBlockCollapseId(key))}
        >
          hide flags
        </button>
        <ShowEventHomeBlock event={EVENT} title="Birthday" />
        <ShowEventHomeBlock event={key} title="the Flag Race" />
      </>
    );
  }

  test("hiding the Flag Race leaves the event's own block alone, and the event page brings it back", async () => {
    renderWithProviders(<EventPage />);
    expect(page.getByText('Show the Flag Race on my home page').query()).toBeNull();
    await userEvent.click(page.getByRole('button', { name: 'hide flags' }));
    await expect.element(page.getByText('Show the Flag Race on my home page')).toBeInTheDocument();
    expect(page.getByText('Show Birthday on my home page').query()).toBeNull();
    await userEvent.click(page.getByText('Show the Flag Race on my home page'));
    await expect
      .element(page.getByText('Show the Flag Race on my home page'))
      .not.toBeInTheDocument();
  });
});
