// @vitest-environment happy-dom
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';

/**
 * useQueryEvent serves the donation event's page: team bank scores and history, rewards, partners,
 * the donor rank. A scored event's page reads its own standings, so none of those may run for it.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DONATION_READS = ['getTeamScores', 'getTeamScoreHistory', 'getRewards', 'getPartners'];
let eventData: { scored: boolean; startDate: Date; endDate: Date } | undefined;
const enabledBy: Record<string, unknown> = {};
const query = (name: string) => ({
  useQuery: (_input: unknown, opts?: { enabled?: unknown }) => {
    enabledBy[name] = opts?.enabled;
    return { data: name === 'getData' ? eventData : undefined, isLoading: false };
  },
});
// Only the reads under test are spied; any other procedure the hook gains answers inertly.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy(
      Object.fromEntries(
        ['getData', 'getCosmetic', 'getUserRank', ...DONATION_READS].map((n) => [
          `event.${n}`,
          query(n),
        ])
      )
    ),
  };
});
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));

const { useQueryEvent } = await import('~/components/Events/events.utils');

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => act(() => root?.unmount()));

function renderHook() {
  function Probe() {
    useQueryEvent({ event: 'an-event' });
    return null;
  }
  root = createRoot(document.createElement('div'));
  act(() => root!.render(React.createElement(Probe)));
}

const live = { startDate: new Date(Date.now() - 1e6), endDate: new Date(Date.now() + 1e6) };

describe('useQueryEvent donation reads', () => {
  it('stay off for a scored event', () => {
    eventData = { scored: true, ...live };
    renderHook();
    for (const name of DONATION_READS) expect([name, !!enabledBy[name]]).toEqual([name, false]);
  });

  // Control: the same render turns them on for a donation event, so the case above is not off
  // because nothing ever turns them on.
  it('run for a donation event', () => {
    eventData = { scored: false, ...live };
    renderHook();
    for (const name of DONATION_READS) expect([name, !!enabledBy[name]]).toEqual([name, true]);
  });

  it('wait for the event data before deciding', () => {
    eventData = undefined;
    renderHook();
    for (const name of DONATION_READS) expect([name, !!enabledBy[name]]).toEqual([name, false]);
  });
});
