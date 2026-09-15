import { useState, type ComponentProps } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * The minimum-view-time gate. EdgeMedia is stubbed to a button that reports playback: headless
 * Chromium cannot decode most clips, and a codec is not what is under test.
 *
 * Clicks go through the DOM node rather than a Playwright locator — the card carries
 * `transition-all` and a hover transform, and the actionability check never settles on anything
 * inside it. Nothing here depends on pointer hit-testing; the handlers are the subject.
 */

// The playhead per clip lives outside the component: it re-renders on every state change the gate
// causes, and a local `let` would rewind to zero each time, which reads as a backwards seek and
// stalls accumulation after one second.
const playheads = vi.hoisted(() => new Map<string, number>());

vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({
    src,
    videoProps,
  }: {
    src: string;
    videoProps?: { onTimeUpdate?: (e: { currentTarget: { currentTime: number } }) => void };
  }) => (
    <button
      type="button"
      data-testid="advance-playback"
      onClick={() => {
        // Four ordinary 250ms samples per click. The first sample of a clip only establishes the
        // baseline, so N clicks are worth (4N - 1) × 250ms of counted playback.
        for (let i = 0; i < 4; i++) {
          const currentTime = (playheads.get(src) ?? 0) + 0.25;
          playheads.set(src, currentTime);
          videoProps?.onTimeUpdate?.({ currentTarget: { currentTime } });
        }
      }}
    >
      play
    </button>
  ),
}));

const { CrucibleJudgingUI } = await import('~/components/Crucible/CrucibleJudgingUI');

const entry = (id: number) => ({
  id,
  imageId: id * 10,
  userId: id * 100,
  image: {
    id: id * 10,
    name: `clip-${id}.webm`,
    url: `0000000${id}-0000-4000-8000-000000000000`,
    type: 'video' as const,
    metadata: { duration: 30 },
    nsfwLevel: 1,
    width: 512,
    height: 512,
  },
  user: { id: id * 100, username: `user${id}`, deletedAt: null, image: null },
});

const pairOf = (left: number, right: number) =>
  ({ left: entry(left), right: entry(right) } as never);

const players = () =>
  document.querySelectorAll<HTMLButtonElement>('[data-testid="advance-playback"]');

const advance = async (side: 0 | 1, clicks: number) => {
  await vi.waitFor(() => expect(players().length).toBe(2));
  for (let i = 0; i < clicks; i++) players()[side].click();
};

// Anchored on the CARD's aria-label, not on the button's text. The text is "Vote" or
// "Watch Ns more" depending on the very gate under test, so a text matcher made the button vanish
// exactly when an assertion needed it — and every `toBeUndefined` then passed vacuously.
// `:not([data-testid])` excludes the media stub, the only other button inside a card.
const voteButton = (side: 'left' | 'right') =>
  document.querySelector<HTMLButtonElement>(
    `[aria-label="Vote for ${side} video"] button:not([data-testid])`
  );

const label = (side: 'left' | 'right') =>
  voteButton(side)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

/** Guards every assertion below: if the selector breaks, this fails rather than they pass. */
const expectBothCardsRendered = async () =>
  vi.waitFor(() => {
    expect(voteButton('left')).toBeTruthy();
    expect(voteButton('right')).toBeTruthy();
  });

beforeEach(() => playheads.clear());

describe('CrucibleJudgingUI — minimum view time', () => {
  test('unlocks voting once BOTH clips have had enough playback', async () => {
    const onVote = vi.fn();
    renderWithProviders(
      <CrucibleJudgingUI pair={pairOf(1, 2)} minViewSeconds={3} onVote={onVote} onSkip={vi.fn()} />
    );

    await expectBothCardsRendered();
    expect(voteButton('left')!.disabled).toBe(true);

    await advance(0, 4);
    await advance(1, 4);

    // The absorbing end state: once the gate opens nothing here shuts it again. The locked state
    // is deliberately not awaited — it is the state that leaves.
    await vi.waitFor(() => expect(voteButton('left')!.disabled).toBe(false));
    voteButton('left')!.click();

    await vi.waitFor(() => expect(onVote).toHaveBeenCalledTimes(1));
    const [winnerId, loserId, watched] = onVote.mock.calls[0];
    expect([winnerId, loserId]).toEqual([1, 2]);
    expect(watched.winnerWatchedMs).toBeGreaterThanOrEqual(3000);
    expect(watched.loserWatchedMs).toBeGreaterThanOrEqual(3000);
  });

  test('stays locked when only ONE clip has been watched', async () => {
    // Negative control for the test above: a gate that never locked would pass that one too.
    const onVote = vi.fn();
    renderWithProviders(
      <CrucibleJudgingUI pair={pairOf(1, 2)} minViewSeconds={3} onVote={onVote} onSkip={vi.fn()} />
    );

    await advance(0, 6);

    // The left card's own label clears — it has been watched through — but the gate is shared, so
    // both buttons stay disabled until the right clip is watched too.
    await expect.element(page.getByText('Watch 3s more')).toBeVisible();
    await expectBothCardsRendered();
    expect(voteButton('left')!.disabled).toBe(true);
    voteButton('left')!.click();
    expect(onVote).not.toHaveBeenCalled();
  });

  test('votes immediately when the crucible sets no minimum', async () => {
    const onVote = vi.fn();
    renderWithProviders(<CrucibleJudgingUI pair={pairOf(1, 2)} onVote={onVote} onSkip={vi.fn()} />);

    await expectBothCardsRendered();
    expect(voteButton('right')!.disabled).toBe(false);
    voteButton('right')!.click();

    await vi.waitFor(() => expect(onVote).toHaveBeenCalledTimes(1));
    expect(onVote.mock.calls[0][0]).toBe(2);
  });

  test('does NOT carry playback into the next pair when an entry repeats', async () => {
    // Pair selection is a random sample excluding only skipped entries, so the same entry
    // routinely appears in consecutive pairs. Keyed on the entry alone, that card kept its
    // accumulated playback and the first timeupdate of the new pair re-opened the gate for free.
    const onVote = vi.fn();
    renderWithProviders(<PairSwitchingHarness onVote={onVote} />);

    await advance(0, 4);
    await advance(1, 4);
    await vi.waitFor(() => expect(voteButton('left')!.disabled).toBe(false));

    // Entry 1 carries over into the next pair; entry 2 is replaced by entry 3.
    document.querySelector<HTMLButtonElement>('[data-testid="next-pair"]')!.click();
    await vi.waitFor(() => expect(voteButton('left')!.disabled).toBe(true));

    await advance(0, 1);
    await advance(1, 1);

    // THE discriminating assertion. The shared gate is not enough on its own: it needs both sides,
    // so the carried-over card alone can never flip it and a `disabled` check passes either way.
    // The carried-over card's OWN label is what tells them apart — one second of playback into a
    // new pair must still read "Watch …", not "Vote".
    expect(label('left')).toMatch(/^Watch/);
    expect(voteButton('left')!.disabled).toBe(true);

    await advance(0, 4);
    await advance(1, 4);
    await vi.waitFor(() => expect(voteButton('left')!.disabled).toBe(false));
    expect(onVote).not.toHaveBeenCalled();
  });
});

type OnVote = ComponentProps<typeof CrucibleJudgingUI>['onVote'];

function PairSwitchingHarness({ onVote }: { onVote: OnVote }) {
  const [right, setRight] = useState(2);
  return (
    <>
      <button type="button" data-testid="next-pair" onClick={() => setRight(3)}>
        next pair
      </button>
      <CrucibleJudgingUI
        pair={pairOf(1, right)}
        minViewSeconds={3}
        onVote={onVote}
        onSkip={vi.fn()}
      />
    </>
  );
}
