import { useState, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * EdgeMedia is stubbed: headless Chromium cannot decode most clips, and a codec is not what is
 * under test.
 *
 * Clicks go through the DOM node rather than a Playwright locator — the card carries
 * `transition-all` and a hover transform, and the actionability check never settles on anything
 * inside it. Nothing here depends on pointer hit-testing; the handlers are the subject.
 */

// The playhead per clip lives outside the component: it re-renders on every state change the gate
// causes, and a local `let` would rewind to zero each time, which reads as a backwards seek and
// stalls accumulation after one second.
const playheads = vi.hoisted(() => new Map<string, number>());
const mediaOutcome = vi.hoisted(() => new Map<string, 'loadedmetadata' | 'error' | 'pending'>());
const lastVideoProps = vi.hoisted(() => new Map<string, Record<string, unknown>>());
// A clip's decoded length. Unset means long enough never to loop within a test.
const clipDurations = vi.hoisted(() => new Map<string, number>());

vi.mock('~/components/EdgeMedia/EdgeMedia', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    EdgeMedia: function EdgeMediaStub({
      src,
      videoProps,
    }: {
      src: string;
      videoProps?: {
        onTimeUpdate?: (e: { currentTarget: { currentTime: number; duration: number } }) => void;
      };
    }) {
      const videoRef = useRef<HTMLVideoElement>(null);
      lastVideoProps.set(src, videoProps ?? {});
      useEffect(() => {
        const outcome = mediaOutcome.get(src) ?? 'loadedmetadata';
        if (outcome !== 'pending') videoRef.current?.dispatchEvent(new Event(outcome));
      }, [src]);

      return (
        <>
          <video ref={videoRef} />
          <button
            type="button"
            data-testid="advance-playback"
            onClick={() => {
              // Four ordinary 250ms samples per click. The first sample of a clip only establishes
              // the baseline, so N clicks are worth (4N - 1) × 250ms of counted playback.
              const duration = clipDurations.get(src) ?? 600;
              for (let i = 0; i < 4; i++) {
                // The real player loops, so a short clip's playhead wraps back to the start.
                const currentTime = ((playheads.get(src) ?? 0) + 0.25) % duration;
                playheads.set(src, currentTime);
                videoProps?.onTimeUpdate?.({ currentTarget: { currentTime, duration } });
              }
            }}
          >
            play
          </button>
        </>
      );
    },
  };
});

const { CrucibleJudgingUI } = await import('~/components/Crucible/CrucibleJudgingUI');

const srcOf = (id: number) => `0000000${id}-0000-4000-8000-000000000000`;

const entry = (id: number, type: 'video' | 'image' = 'video') => ({
  id,
  imageId: id * 10,
  userId: id * 100,
  image: {
    id: id * 10,
    name: `clip-${id}.webm`,
    url: srcOf(id),
    type,
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

const card = (side: 'left' | 'right') =>
  document.querySelector<HTMLElement>(`[aria-label="Vote for ${side} video"]`);

// Anchored on the CARD's aria-label, not on the button's text. The text is "Vote" or
// "Watch Ns more" depending on the very gate under test, so a text matcher made the button vanish
// exactly when an assertion needed it — and every `toBeUndefined` then passed vacuously.
const voteButton = (side: 'left' | 'right') =>
  card(side)?.querySelector<HTMLButtonElement>('[data-testid="judge-vote"]') ?? null;

const mediaStatus = (side: 'left' | 'right') =>
  card(side)?.querySelector<HTMLElement>('[data-media-status]')?.dataset.mediaStatus;

const video = (side: 'left' | 'right') => card(side)!.querySelector('video')!;

const label = (side: 'left' | 'right') =>
  voteButton(side)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

/**
 * Guards every assertion below: if the selector breaks, this fails rather than they pass. Also
 * waits out media loading, so a locked vote below is the gate under test and not a pending load.
 */
const expectBothCardsRendered = async () =>
  vi.waitFor(() => {
    expect(voteButton('left')).toBeTruthy();
    expect(voteButton('right')).toBeTruthy();
    expect(mediaStatus('left')).toBe('loaded');
    expect(mediaStatus('right')).toBe('loaded');
  });

beforeEach(() => {
  playheads.clear();
  clipDurations.clear();
  mediaOutcome.clear();
  lastVideoProps.clear();
});

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

const skipPairButton = () =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes('Skip Pair')
  );

describe('CrucibleJudgingUI — clip already judged this session', () => {
  const pairWithWatch = (left: number, right: number) =>
    ({ left: entry(left), right: entry(right), watchSeconds: { left: 1, right: 3 } } as never);

  test('a clip the server marks as seen needs only its shortened watch', async () => {
    const onVote = vi.fn();
    renderWithProviders(
      <CrucibleJudgingUI
        pair={pairWithWatch(1, 2)}
        minViewSeconds={3}
        onVote={onVote}
        onSkip={vi.fn()}
      />
    );
    await expectBothCardsRendered();

    // Two clicks = 1750ms: past the 1s repeat watch, short of the 3s minimum.
    await advance(0, 2);
    await advance(1, 4);

    await vi.waitFor(() => expect(voteButton('left')!.disabled).toBe(false));
    voteButton('left')!.click();
    await vi.waitFor(() => expect(onVote).toHaveBeenCalledTimes(1));
  });

  test('the same playback leaves the gate shut when the clip is new', async () => {
    renderWithProviders(
      <CrucibleJudgingUI pair={pairOf(1, 2)} minViewSeconds={3} onVote={vi.fn()} onSkip={vi.fn()} />
    );
    await expectBothCardsRendered();

    await advance(0, 2);
    await advance(1, 4);

    await vi.waitFor(() => expect(label('right')).toMatch(/^Vote/));
    expect(label('left')).toMatch(/^Watch 2s more/);
    expect(voteButton('left')!.disabled).toBe(true);
  });
});

describe('CrucibleJudgingUI — skipping', () => {
  test("a skip with both entries showing is the judge's own", async () => {
    const onSkip = vi.fn();
    renderWithProviders(<CrucibleJudgingUI pair={pairOf(1, 2)} onVote={vi.fn()} onSkip={onSkip} />);
    await expectBothCardsRendered();

    skipPairButton()!.click();

    expect(onSkip).toHaveBeenCalledWith({ unavailable: false });
  });

  test("any skip while an entry didn't load is reported as unavailable", async () => {
    mediaOutcome.set(srcOf(2), 'error');
    const onSkip = vi.fn();
    renderWithProviders(<CrucibleJudgingUI pair={pairOf(1, 2)} onVote={vi.fn()} onSkip={onSkip} />);
    await vi.waitFor(() => expect(mediaStatus('right')).toBe('error'));

    skipPairButton()!.click();

    expect(onSkip).toHaveBeenCalledWith({ unavailable: true });
  });
});

describe('CrucibleJudgingUI — repeated clicks', () => {
  // Past the 200ms feedback delay, so any second vote still queued would have landed by now.
  const pastFeedbackDelay = () => new Promise((resolve) => setTimeout(resolve, 400));

  test('a burst of clicks before the vote lands casts one vote', async () => {
    const onVote = vi.fn();
    renderWithProviders(<CrucibleJudgingUI pair={pairOf(1, 2)} onVote={onVote} onSkip={vi.fn()} />);
    await expectBothCardsRendered();

    for (let i = 0; i < 5; i++) voteButton('right')!.click();
    await pastFeedbackDelay();

    expect(onVote).toHaveBeenCalledTimes(1);
  });

  test('takes the next vote once the first has landed', async () => {
    // Control for the test above: a lock that never released would also cast exactly one vote.
    const onVote = vi.fn();
    renderWithProviders(<CrucibleJudgingUI pair={pairOf(1, 2)} onVote={onVote} onSkip={vi.fn()} />);
    await expectBothCardsRendered();

    voteButton('right')!.click();
    await vi.waitFor(() => expect(onVote).toHaveBeenCalledTimes(1));
    voteButton('left')!.click();

    await vi.waitFor(() => expect(onVote).toHaveBeenCalledTimes(2));
  });
});

describe('CrucibleJudgingUI — media loading', () => {
  test('keeps voting locked while one side has not loaded', async () => {
    // "votes immediately when the crucible sets no minimum" is the control: same props, both load.
    mediaOutcome.set(srcOf(2), 'pending');
    const onVote = vi.fn();
    renderWithProviders(<CrucibleJudgingUI pair={pairOf(1, 2)} onVote={onVote} onSkip={vi.fn()} />);

    await vi.waitFor(() => expect(mediaStatus('left')).toBe('loaded'));
    expect(mediaStatus('right')).toBe('loading');
    expect(voteButton('left')!.disabled).toBe(true);
    voteButton('left')!.click();
    expect(onVote).not.toHaveBeenCalled();
  });

  test('a side that fails to load offers Skip, and Retry reloads it', async () => {
    mediaOutcome.set(srcOf(2), 'error');
    const onVote = vi.fn();
    const onSkip = vi.fn();
    renderWithProviders(<CrucibleJudgingUI pair={pairOf(1, 2)} onVote={onVote} onSkip={onSkip} />);

    await vi.waitFor(() => expect(mediaStatus('right')).toBe('error'));
    expect(voteButton('left')!.disabled).toBe(true);

    const overlayButton = (text: string) =>
      [...card('right')!.querySelectorAll<HTMLButtonElement>('[role="alert"] button')].find((b) =>
        b.textContent?.includes(text)
      );
    overlayButton('Skip pair')!.click();
    expect(onSkip).toHaveBeenCalledTimes(1);
    // Not the judge's choice, so the page keeps their streak.
    expect(onSkip).toHaveBeenCalledWith({ unavailable: true });

    mediaOutcome.set(srcOf(2), 'loadedmetadata');
    overlayButton('Retry')!.click();
    await vi.waitFor(() => expect(voteButton('left')!.disabled).toBe(false));
    expect(mediaStatus('right')).toBe('loaded');
    expect(onVote).not.toHaveBeenCalled();
  });

  describe('load timeout', () => {
    afterEach(() => vi.useRealTimers());

    const statusOf = (side: 'left' | 'right') =>
      document
        .querySelector(`[aria-label^="Vote for ${side}"]`)
        ?.querySelector<HTMLElement>('[data-media-status]')?.dataset.mediaStatus;

    test('gives up on an image after 12s and on a video after 20s', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      mediaOutcome.set(srcOf(1), 'pending');
      mediaOutcome.set(srcOf(2), 'pending');
      renderWithProviders(
        <CrucibleJudgingUI
          pair={{ left: entry(1, 'image'), right: entry(2) } as never}
          onVote={vi.fn()}
          onSkip={vi.fn()}
        />
      );
      await vi.waitFor(() => expect(statusOf('left')).toBe('loading'));

      vi.advanceTimersByTime(12_100);
      await vi.waitFor(() => expect(statusOf('left'), 'image after 12s').toBe('error'));
      // Rendered in the same pass as the image's timeout, so a video timer that had also fired
      // would show here.
      expect(statusOf('right'), 'video after 12s').toBe('loading');

      vi.advanceTimersByTime(8_000);
      await vi.waitFor(() => expect(statusOf('right'), 'video after 20s').toBe('error'));
    });
  });
});

describe('CrucibleJudgingUI — video playback', () => {
  test('clips start with sound on, and the sound toggle mutes them', async () => {
    renderWithProviders(
      <CrucibleJudgingUI pair={pairOf(1, 2)} onVote={vi.fn()} onSkip={vi.fn()} />
    );
    await expectBothCardsRendered();

    expect(video('left').muted).toBe(false);
    expect(video('right').muted).toBe(false);

    card('left')!.querySelector<HTMLButtonElement>('[aria-label="Mute clips"]')!.click();
    await vi.waitFor(() => {
      expect(video('left').muted).toBe(true);
      expect(video('right').muted).toBe(true);
    });
  });

  test('a clip the browser refuses to play with sound plays muted instead', async () => {
    const mutedPlays: HTMLMediaElement[] = [];
    const play = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockImplementation(function (this: HTMLMediaElement) {
        if (!this.muted)
          return Promise.reject(new DOMException('needs a gesture', 'NotAllowedError'));
        mutedPlays.push(this);
        return Promise.resolve();
      });
    renderWithProviders(
      <CrucibleJudgingUI pair={pairOf(1, 2)} minViewSeconds={3} onVote={vi.fn()} onSkip={vi.fn()} />
    );
    await expectBothCardsRendered();

    await vi.waitFor(() => expect(mutedPlays).toContain(video('left')));
    expect(video('left').muted).toBe(true);
    // The toggle reflects what the judge actually hears, and the other clip follows it.
    await vi.waitFor(() =>
      expect(card('left')!.querySelector('[aria-label="Unmute clips"]')).toBeTruthy()
    );
    expect(video('right').muted).toBe(true);
    play.mockRestore();
  });

  test('sound refused on one pair is tried again on the next', async () => {
    let refuseSound = true;
    const soundPlays: HTMLMediaElement[] = [];
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (
      this: HTMLMediaElement
    ) {
      if (this.muted) return Promise.resolve();
      if (refuseSound)
        return Promise.reject(new DOMException('needs a gesture', 'NotAllowedError'));
      soundPlays.push(this);
      return Promise.resolve();
    });
    renderWithProviders(<PairSwitchingHarness onVote={vi.fn()} />);
    await expectBothCardsRendered();
    await vi.waitFor(() =>
      expect(card('left')!.querySelector('[aria-label="Unmute clips"]')).toBeTruthy()
    );

    // By the next pair the judge has clicked something, so the browser now allows sound.
    refuseSound = false;
    document.querySelector<HTMLButtonElement>('[data-testid="next-pair"]')!.click();

    await vi.waitFor(() => expect(soundPlays).toContain(video('left')));
    expect(card('left')!.querySelector('[aria-label="Mute clips"]')).toBeTruthy();
    vi.restoreAllMocks();
  });

  test("the judge's own mute carries over to the next pair", async () => {
    // Control for the test above: only a browser refusal is retried, never the judge's choice.
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    renderWithProviders(<PairSwitchingHarness onVote={vi.fn()} />);
    await expectBothCardsRendered();

    card('left')!.querySelector<HTMLButtonElement>('[aria-label="Mute clips"]')!.click();
    await vi.waitFor(() => expect(video('left').muted).toBe(true));
    const firstPairVideo = video('left');
    document.querySelector<HTMLButtonElement>('[data-testid="next-pair"]')!.click();
    await vi.waitFor(() => {
      expect(video('left')).not.toBe(firstPairVideo);
      expect(card('left')!.querySelector('[aria-label="Unmute clips"]')).toBeTruthy();
    });
    expect(video('left').muted).toBe(true);
    vi.restoreAllMocks();
  });

  test('a clip that starts playing pauses the other one', async () => {
    renderWithProviders(
      <CrucibleJudgingUI pair={pairOf(1, 2)} onVote={vi.fn()} onSkip={vi.fn()} />
    );
    await expectBothCardsRendered();

    const pauseLeft = vi.spyOn(video('left'), 'pause');
    const pauseRight = vi.spyOn(video('right'), 'pause');
    video('left').dispatchEvent(new Event('play'));

    await vi.waitFor(() => expect(pauseRight).toHaveBeenCalled());
    expect(pauseLeft).not.toHaveBeenCalled();
  });

  test("turns off the player's own hover-to-play, which a tap also triggers", async () => {
    renderWithProviders(
      <CrucibleJudgingUI pair={pairOf(1, 2)} onVote={vi.fn()} onSkip={vi.fn()} />
    );
    await expectBothCardsRendered();

    expect(lastVideoProps.get(srcOf(1))).toMatchObject({ hoverPlay: false });
    expect(lastVideoProps.get(srcOf(2))).toMatchObject({ hoverPlay: false });
  });
});

describe('CrucibleJudgingUI — sequenced preview', () => {
  const spies = () => ({
    play: vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined),
    pause: vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined),
  });
  afterEach(() => vi.restoreAllMocks());

  test('plays the left clip, then the right, then leaves the judge on their own', async () => {
    const { play, pause } = spies();
    renderWithProviders(
      <CrucibleJudgingUI pair={pairOf(1, 2)} minViewSeconds={3} onVote={vi.fn()} onSkip={vi.fn()} />
    );
    await expectBothCardsRendered();

    await vi.waitFor(() => expect(play.mock.contexts).toContain(video('left')));
    expect(play.mock.contexts).not.toContain(video('right'));

    await advance(0, 4);

    await vi.waitFor(() => expect(pause.mock.contexts).toContain(video('left')));
    await vi.waitFor(() => expect(play.mock.contexts).toContain(video('right')));
    expect(voteButton('left')!.disabled).toBe(true);

    await advance(1, 4);

    await vi.waitFor(() => expect(voteButton('left')!.disabled).toBe(false));
    await vi.waitFor(() => expect(pause.mock.contexts).toContain(video('right')));
  });

  test('does not start without a minimum view time', async () => {
    // Negative control: the sequence is driven by the rule, not by every video pair.
    const { play } = spies();
    renderWithProviders(
      <CrucibleJudgingUI pair={pairOf(1, 2)} onVote={vi.fn()} onSkip={vi.fn()} />
    );
    await expectBothCardsRendered();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(play).not.toHaveBeenCalled();
  });

  test('a clip shorter than the rule only has to play to its own end', async () => {
    spies();
    // 1.5s: the first click plays to 1.0s, the second wraps the playhead back to the start.
    clipDurations.set(srcOf(1), 1.5);
    const onVote = vi.fn();
    renderWithProviders(
      <CrucibleJudgingUI pair={pairOf(1, 2)} minViewSeconds={3} onVote={onVote} onSkip={vi.fn()} />
    );
    await expectBothCardsRendered();

    await advance(0, 1);
    await advance(1, 4);
    // Not yet: a 1s clip whose playhead has not wrapped has not been seen to its end.
    expect(voteButton('left')!.disabled).toBe(true);

    await advance(0, 1);

    await vi.waitFor(() => expect(voteButton('left')!.disabled).toBe(false));
    voteButton('left')!.click();
    await vi.waitFor(() => expect(onVote).toHaveBeenCalledTimes(1));
    // The server gate checks the rule, not the clip's length.
    expect(onVote.mock.calls[0][2].winnerWatchedMs).toBeGreaterThanOrEqual(3000);
  });

  test('a sub-second clip stays locked until it has actually played', async () => {
    spies();
    clipDurations.set(srcOf(1), 0.3);
    clipDurations.set(srcOf(2), 0.3);
    renderWithProviders(
      <CrucibleJudgingUI pair={pairOf(1, 2)} minViewSeconds={3} onVote={vi.fn()} onSkip={vi.fn()} />
    );
    await expectBothCardsRendered();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(voteButton('left')!.disabled).toBe(true);

    await advance(0, 1);
    await advance(1, 1);

    await vi.waitFor(() => expect(voteButton('left')!.disabled).toBe(false));
  });

  test('a wrapping playhead does not count for a clip longer than the rule', async () => {
    // Negative control: on a long clip, a wrap is a skip to the end, not a finished viewing.
    spies();
    clipDurations.set(srcOf(1), 10);
    playheads.set(srcOf(1), 9.6);
    renderWithProviders(
      <CrucibleJudgingUI pair={pairOf(1, 2)} minViewSeconds={6} onVote={vi.fn()} onSkip={vi.fn()} />
    );
    await expectBothCardsRendered();

    await advance(0, 1);

    await vi.waitFor(() => expect(playheads.get(srcOf(1))).toBeLessThan(1));
    expect(label('left')).toMatch(/^Watch \d+s more/);
  });
});

describe('CrucibleJudgingUI — hotkeys', () => {
  const press = (key: string, code: string, repeat: boolean) =>
    document.documentElement.dispatchEvent(
      new KeyboardEvent('keydown', { key, code, repeat, bubbles: true })
    );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

  test('a held vote key votes once, not once per auto-repeat', async () => {
    const onVote = vi.fn();
    renderWithProviders(<CrucibleJudgingUI pair={pairOf(1, 2)} onVote={onVote} onSkip={vi.fn()} />);
    await expectBothCardsRendered();

    press('2', 'Digit2', false);
    for (let i = 0; i < 5; i++) press('2', 'Digit2', true);

    await vi.waitFor(() => expect(onVote).toHaveBeenCalledTimes(1));
    await settle();
    expect(onVote).toHaveBeenCalledTimes(1);
    expect(onVote.mock.calls[0][0]).toBe(2);
  });

  test('a held skip key skips once', async () => {
    const onSkip = vi.fn();
    renderWithProviders(<CrucibleJudgingUI pair={pairOf(1, 2)} onVote={vi.fn()} onSkip={onSkip} />);
    await expectBothCardsRendered();

    press(' ', 'Space', false);
    for (let i = 0; i < 5; i++) press(' ', 'Space', true);

    await vi.waitFor(() => expect(onSkip).toHaveBeenCalledTimes(1));
    await settle();
    expect(onSkip).toHaveBeenCalledTimes(1);
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
