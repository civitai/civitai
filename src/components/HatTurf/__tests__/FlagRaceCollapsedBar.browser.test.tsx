import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import type * as Trpc from '~/utils/trpc';
import type { FlagSummary } from '~/server/events/turf/turf.service';

import '~/styles/globals.css';

/** The home Flag Race row: full, shrunk to a bar, hidden, and the event page's way back. */

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy({
      'event.getData': { useQuery: () => ({ data: { teams: ['Green', 'Blue'] } }) },
      'hatTurf.getOpenFlagCrucible': { useQuery: () => ({ data: null, refetch: () => undefined }) },
    }),
  };
});

// The real wrapper reads the home page's masonry layout, which this page has none of.
vi.mock('~/components/HomeBlocks/HomeBlockWrapper', () => ({
  HomeBlockWrapper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { useNavBannersDismissed } from '~/components/AppLayout/NavAnnouncementSlot/nav-banners-dismissed';
import { FlagRaceHomeRow } from '~/components/HatTurf/FlagRace/FlagRaceCollapsedBar';
import { FlagRacePanel } from '~/components/HatTurf/FlagRace/FlagRacePanel';
import { ShowEventHomeBlock } from '~/components/HomeBlocks/ShowEventHomeBlock';
import { eventHomeBlockDismissId } from '~/components/HomeBlocks/scored-event-home-block.utils';
import { renderWithProviders } from '../../../../test/component-setup';

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

// The dismissed list lives in a module store for the tab, so each test takes its own event.
function Home({ event, s = summary() }: { event: string; s?: FlagSummary }) {
  const { dismiss } = useNavBannersDismissed();
  return (
    <>
      <FlagRaceHomeRow event={event} summary={s}>
        <div>{"today's flags"}</div>
      </FlagRaceHomeRow>
      <ShowEventHomeBlock event={event} title="Birthday" />
      <button onClick={() => dismiss(eventHomeBlockDismissId(event))}>hide the event block</button>
    </>
  );
}

const collapse = () =>
  userEvent.click(page.getByRole('button', { name: 'Collapse the Flag Race' }));
const flags = () => page.getByText("today's flags");
const showFlags = () => page.getByText('Show the Flag Race on my home page');
const showEvent = () => page.getByText('Show Birthday on my home page');

afterEach(async () => {
  await cleanup();
});

describe('the home Flag Race row', () => {
  test('X shrinks it to a bar, Show opens it again, and the bar X hides it until the event page brings it back', async () => {
    renderWithProviders(<Home event="e1" />);
    await expect.element(flags()).toBeInTheDocument();

    await collapse();
    await expect.element(page.getByText('1.2k points up for grabs')).toBeInTheDocument();
    expect(flags().query()).toBeNull();
    expect(showFlags().query()).toBeNull();

    await userEvent.click(page.getByRole('button', { name: 'Show' }));
    await expect.element(flags()).toBeInTheDocument();

    await collapse();
    await userEvent.click(page.getByRole('button', { name: 'Hide the Flag Race' }));
    await expect.element(showFlags()).toBeInTheDocument();
    expect(flags().query()).toBeNull();
    expect(page.getByText(/points up for grabs/).query()).toBeNull();
    expect(showEvent().query()).toBeNull();

    await userEvent.click(showFlags());
    await expect.element(flags()).toBeInTheDocument();
    expect(showFlags().query()).toBeNull();
  });

  test("hiding the event's own block leaves the Flag Race row", async () => {
    renderWithProviders(<Home event="e2" />);
    await userEvent.click(page.getByRole('button', { name: 'hide the event block' }));
    await expect.element(showEvent()).toBeInTheDocument();
    await expect.element(flags()).toBeInTheDocument();
    expect(showFlags().query()).toBeNull();
  });

  test('a closed day says it is counting, with no pot and no holders', async () => {
    renderWithProviders(<Home event="e3" s={summary({ closed: true })} />);
    await collapse();
    await expect.element(page.getByText('Counting today’s flags')).toBeInTheDocument();
    expect(page.getByText(/points up for grabs/).query()).toBeNull();
    expect(page.getByLabelText(/holds/).query()).toBeNull();
  });

  test('with no pot yet, the bar counts the flags', async () => {
    renderWithProviders(<Home event="e4" s={summary({ pot: 0 })} />);
    await collapse();
    await expect.element(page.getByText('2 flags up today')).toBeInTheDocument();
    await expect.element(page.getByLabelText('Green holds 1 flag')).toBeInTheDocument();
  });

  test("the event page's panel has no collapse X", async () => {
    renderWithProviders(<FlagRacePanel event="e5" summary={summary()} />);
    await expect.element(page.getByText('Flag Race')).toBeInTheDocument();
    expect(page.getByRole('button', { name: 'Collapse the Flag Race' }).query()).toBeNull();
  });
});
