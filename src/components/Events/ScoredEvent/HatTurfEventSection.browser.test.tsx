import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';

const h = vi.hoisted(() => ({
  user: { id: 1 } as { id: number } | null,
  flags: { hatTurfImageDetail: true, hatTurfFeedCard: false },
  // The event Hat Turf runs for on a surface this viewer can see; undefined: none.
  playable: 'birthday2026' as string | undefined,
  stock: { available: 3, optedIn: false, mode: 'live' } as
    | { available: number; optedIn: boolean; mode: string }
    | undefined,
  mutate: vi.fn(),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy({
      'hatTurf.getStock': {
        useQuery: (_input: unknown, opts: { enabled?: boolean }) => ({
          data: opts.enabled === false ? undefined : h.stock,
        }),
      },
      'hatTurf.setOptIn': { useMutation: () => ({ isPending: false, mutate: h.mutate }) },
    }),
  };
});
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => h.user }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => h.flags,
}));
vi.mock('~/components/Decorations/usePlayableEventDecoration', () => ({
  usePlayableEventDecoration: (_entity: string, enabled = true) =>
    enabled && h.playable ? { event: h.playable } : undefined,
}));

import { cleanup } from 'vitest-browser-react';
import { HatTurfEventSection } from './HatTurfEventSection';
import { renderWithProviders } from '../../../../test/component-setup';

const section = () => document.body.querySelector('[data-testid="hat-turf-event-section"]');
const button = (name: RegExp) =>
  [...document.body.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));
const render = (team: string | undefined) =>
  renderWithProviders(<HatTurfEventSection event="birthday2026" team={team} />);
// Everything here renders on the first commit (mocks are synchronous): a tick is enough to know a
// section is absent, and the shown rows are the positive control for the hidden ones.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  h.user = { id: 1 };
  h.flags = { hatTurfImageDetail: true, hatTurfFeedCard: false };
  h.playable = 'birthday2026';
  h.stock = { available: 3, optedIn: false, mode: 'live' };
  h.mutate.mockReset();
});
afterEach(() => cleanup());

describe('Hat Turf on the event page', () => {
  test('not joined: says what Hat Turf is, and Join turns it on', async () => {
    await render('blue');
    await vi.waitFor(() => expect(section()).not.toBeNull());
    expect(section()!.textContent).toMatch(/any picture/);
    button(/^Join Hat Turf$/)!.click();
    expect(h.mutate).toHaveBeenCalledWith({ event: 'birthday2026', optedIn: true });
  });

  test("joined: says you're in, and Leave turns it off", async () => {
    h.stock = { available: 3, optedIn: true, mode: 'live' };
    await render('blue');
    await vi.waitFor(() => expect(section()).not.toBeNull());
    expect(section()!.textContent).toMatch(/You're in/);
    expect(button(/^Join Hat Turf$/)).toBeUndefined();
    button(/^Leave Hat Turf$/)!.click();
    expect(h.mutate).toHaveBeenCalledWith({ event: 'birthday2026', optedIn: false });
  });

  test.each([
    ['signed out', () => (h.user = null), 'blue'],
    ['on no team', () => undefined, undefined],
    ['turf off', () => (h.stock = { available: 0, optedIn: false, mode: 'off' }), 'blue'],
    ['flags off', () => (h.flags = { hatTurfImageDetail: false, hatTurfFeedCard: false }), 'blue'],
    ['turf running for another event', () => (h.playable = 'other'), 'blue'],
  ])('hidden when %s', async (_, arrange, team) => {
    arrange();
    await render(team);
    await settle();
    expect(section()).toBeNull();
  });
});
