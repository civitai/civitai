import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderHook } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import { act } from 'react';
import type * as TrpcUtils from '~/utils/trpc';
import type * as TipBuzzButton from '~/components/Buzz/InteractiveTipBuzzButton';
import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

/**
 * The reaction nudge's gates, against the real reaction store: it glows the bar of an armed image
 * only for a signed-in viewer who does not own it, has not reacted to it and shows event cosmetics,
 * and arms an image once per session.
 */

const viewer = vi.hoisted(() => ({ user: { id: 1 } as { id: number } | null, cosmetics: true }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => viewer.user }));
vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useShowEventCosmetics: () => viewer.cosmetics,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useFeatureFlags: () => ({}),
}));
const toggle = vi.hoisted(() => vi.fn());
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcUtils>()),
  trpc: makeTrpcProxy({
    'reaction.toggleWithPoints': { useMutation: () => ({ mutate: toggle, isPending: false }) },
  }),
}));
vi.mock('~/components/Buzz/InteractiveTipBuzzButton', async (importOriginal) => ({
  ...(await importOriginal<typeof TipBuzzButton>()),
  InteractiveTipBuzzButton: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { armReactionNudge, useReactionNudgeClass, REACTION_NUDGE_MS, REACTION_NUDGE_DELAY_MS } =
  await import('~/components/HatTurf/reaction-nudge');
const { Reactions } = await import('~/components/Reaction/Reactions');

// Each case arms its own image: the stores are module-wide.
let nextImage = 1;
const OWNER = 2;

// Only timeouts are faked: the arm's delay and expiry are what the cases step through.
beforeEach(() => {
  // Every test file in a worker's tab shares sessionStorage: HatTurfDetail's tests place on image 9
  // and arm its nudge, which made this file's image 9 a repeat whenever they ran first.
  sessionStorage.clear();
  viewer.user = { id: 1 };
  viewer.cosmetics = true;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const nudgeOn = (imageId: number, reactions: { userId: number; reaction: string }[] = []) =>
  renderHook(() => useReactionNudgeClass({ imageId, ownerId: OWNER, reactions }));
const yes = async () => true;
/** Arms the image and waits out the delay and the earns answer before the glow starts. */
const arm = async (imageId: number, team = 'Blue', earns = yes) => {
  armReactionNudge(imageId, team, earns);
  await act(() => vi.advanceTimersByTimeAsync(REACTION_NUDGE_DELAY_MS));
};

describe('reaction nudge', () => {
  test("glows an armed image's bar in the team's colour, and only that image's", async () => {
    const armed = nextImage++;
    const other = nextImage++;
    await arm(armed, 'Pink');
    const { result } = await nudgeOn(armed);
    expect(result.current).toMatch(/nudge/);
    expect(result.current).toMatch(/pink/);
    expect((await nudgeOn(other)).result.current).toBeUndefined();
  });

  test('asks whether a reaction earns only once servers have the new map, then stops after two pulses', async () => {
    const id = nextImage++;
    const earns = vi.fn(yes);
    armReactionNudge(id, 'Blue', earns);
    const { result } = await nudgeOn(id);
    await act(() => vi.advanceTimersByTimeAsync(REACTION_NUDGE_DELAY_MS - 1));
    expect(earns).not.toHaveBeenCalled();
    expect(result.current).toBeUndefined();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(earns).toHaveBeenCalledTimes(1);
    expect(result.current).toMatch(/nudge/);
    await act(() => vi.advanceTimersByTimeAsync(REACTION_NUDGE_MS));
    expect(result.current).toBeUndefined();
  });

  test('no glow where a reaction would not earn, or the ask fails', async () => {
    const no = nextImage++;
    await arm(no, 'Blue', async () => false);
    expect((await nudgeOn(no)).result.current).toBeUndefined();
    const failed = nextImage++;
    await arm(failed, 'Blue', () => Promise.reject(new Error('offline')));
    expect((await nudgeOn(failed)).result.current).toBeUndefined();
  });

  test('never on your own image, signed out, or with event cosmetics off', async () => {
    const id = nextImage++;
    await arm(id);
    viewer.user = { id: OWNER };
    expect((await nudgeOn(id)).result.current).toBeUndefined();
    viewer.user = null;
    expect((await nudgeOn(id)).result.current).toBeUndefined();
    viewer.user = { id: 1 };
    viewer.cosmetics = false;
    expect((await nudgeOn(id)).result.current).toBeUndefined();
    // The control: the same image, with every gate open, does glow.
    viewer.cosmetics = true;
    expect((await nudgeOn(id)).result.current).toMatch(/nudge/);
  });

  const bar = (entityId: number, reactions: { userId: number; reaction: 'Like' | 'Heart' }[]) =>
    renderWithProviders(
      <Reactions
        entityType="image"
        entityId={entityId}
        reactions={reactions}
        metrics={{ likeCount: 1, heartCount: 1, laughCount: 1, cryCount: 1 }}
        targetUserId={OWNER}
      />
    );

  test('not once you have reacted: before this visit, or now', async () => {
    const before = nextImage++;
    await arm(before);
    expect(
      (await nudgeOn(before, [{ userId: 1, reaction: 'Like' }])).result.current
    ).toBeUndefined();

    const now = nextImage++;
    await arm(now);
    const { result } = await nudgeOn(now);
    expect(result.current).toMatch(/nudge/);
    // A real reaction click: the bar puts it in the store before the server answers.
    await bar(now, []);
    await page.getByRole('button', { name: /^Heart reaction/ }).click();
    expect(toggle).toHaveBeenCalled();
    expect(result.current).toBeUndefined();
  });

  // Un-reacting takes the earlier reaction's points back, so a new one would earn again.
  test('glows again once you take back a reaction from before this visit', async () => {
    const id = nextImage++;
    await arm(id);
    const reactions = [{ userId: 1, reaction: 'Like' as const }];
    const { result } = await nudgeOn(id, reactions);
    expect(result.current).toBeUndefined();
    await bar(id, reactions);
    await page.getByRole('button', { name: /^Like reaction/ }).click();
    expect(result.current).toMatch(/nudge/);
  });

  test('an image is nudged once per session, however often it is stickered', async () => {
    const id = nextImage++;
    await arm(id);
    await act(() => vi.advanceTimersByTimeAsync(REACTION_NUDGE_MS));
    await arm(id);
    expect((await nudgeOn(id)).result.current).toBeUndefined();
  });
});
