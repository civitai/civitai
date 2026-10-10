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
const { CrucibleJudgingBriefing } = await import('~/components/Crucible/CrucibleJudgingBriefing');

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

// Anchored on the button's side, not on its text. The text is "Vote" or "Watch Ns more"
// depending on the very gate under test, so a text matcher made the button vanish exactly when an
// assertion needed it — and every `toBeUndefined` then passed vacuously.
const voteButton = (side: 'left' | 'right') =>
  document.querySelector<HTMLButtonElement>(`[data-testid="judge-vote"][data-side="${side}"]`);

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

/**
 * Which of THIS pair's cards a media spy was called on, by CONTAINMENT rather than by element
 * identity.
 *
 * `expect(spy.mock.contexts).toContain(video(side))` compares the recorded element against the one
 * in the DOM now, and the two diverge the moment a `<video>` is replaced — which makes a POSITIVE
 * assertion unsatisfiable (noisy red) and a NEGATIVE one vacuous (silent green). A replaced
 * element is still inside its own card, so this survives that; a media element elsewhere on the
 * page is still excluded, which a bare `expect(spy).toHaveBeenCalled()` is not.
 */
const sidesCalledOn = (spy: { mock: { contexts: unknown[] } }) =>
  (['left', 'right'] as const).filter((side) =>
    spy.mock.contexts.some((ctx) => ctx instanceof Node && card(side)!.contains(ctx))
  );

/**
 * Resolves strictly AFTER React has flushed the passive effects of any commit already made.
 *
 * Needed because a committed DOM read is not a happens-before for that commit's effects: React
 * writes the DOM during commit and flushes passive effects from a `MessageChannel` task posted
 * during it, so a message posted after we observe the DOM is processed behind React's. Two hops
 * cover the scheduler yielding mid-queue. `act()` would be the direct tool and is not usable in
 * this repo — see the note in `src/components/Apps/AppsRailNav.ssrHydration.browser.test.tsx`.
 *
 * This is a scheduler ordering guarantee, not a wall-clock wait: it costs no fixed time, and
 * lengthening it could never make an absence assertion more likely to fail.
 */
const afterPassiveEffects = async () => {
  for (let hop = 0; hop < 2; hop++)
    await new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(null);
    });
};

/**
 * 🔴 THE MEASURED ROOT CAUSE OF THIS FILE'S INTERMITTENT CI REDS. DO NOT REMOVE — the two tests it
 * protects are named below, and deleting this makes them flaky again rather than failing.
 *
 * Browser mode reuses ONE page per worker across test files, and 62 of the 296 files in this
 * project drive the real pointer (`userEvent`, `locator.hover()`). So by the time this file's
 * iframe mounts, Chromium can already hold a cursor position — and it re-dispatches hover at that
 * point whenever layout changes, i.e. when a judging pair appears under it. `CrucibleJudgingUI`
 * answers a real mouse enter by PLAYING that clip (`handlePointerEnter`, correct behaviour when
 * the preview sequence is off), so the suite receives a `play()` nobody in it asked for.
 *
 * Measured, not inferred: a full-project run that reproduced the red carried
 * `pointerover/mouse@Vote for right video` plus seven `pointerenter/mouse`, and the rogue `play()`
 * was on that same card's clip. Running this file ALONE never reproduces it — that page has seen
 * no pointer — which is why it looked like contention.
 *
 * What it breaks:
 *  - `does not start without a minimum view time` — the hover's `play()` IS the call that test
 *    asserts never happens, and it is not the sequence the test is about.
 *  - `a clip that starts playing pauses the other one` — the hover sets `playingSide` before the
 *    spy is installed, so that test's own synthetic `play` writes the same value, the other card's
 *    `otherPlaying` never changes, its effect never re-runs and nothing is ever paused.
 *
 * Dropped in the CAPTURE phase at the document, which runs before React's listener on the render
 * container, so `stopPropagation()` keeps these out of the component entirely. Nothing in this file
 * wants pointer input — every interaction here is a direct `.click()` — and the suppression is
 * guarded by its own test in the `stray pointer input` describe below, so a regression here fails
 * rather than returning silently.
 *
 * Deliberately NOT in `test/component-setup.tsx`: those 62 files include real `.hover()`
 * assertions, so suppressing this project-wide would break them. It belongs to the specs whose
 * component reacts to hover and whose tests never mean to.
 */
for (const type of [
  'pointerover',
  'pointerout',
  'pointermove',
  'mouseover',
  'mouseout',
  'mousemove',
])
  document.addEventListener(type, (event) => event.stopPropagation(), true);

// File-level, not per-describe. Every `vi.spyOn` in this file installs on
// `HTMLMediaElement.prototype`, and a restore written as the last statement of a test body does
// not run when that test FAILS — so a failing test hands its spy to every later test, and
// `vi.spyOn` on an already-spied method returns the SAME spy with its call record intact
// (measured), which would make a later `not.toHaveBeenCalled()` read the earlier test's calls.
// `afterEach` runs on a failing test too. Kept here rather than in the two describes that install
// spies today, so the next describe that installs one cannot be born without teardown.
// Ordering note: the setup file registers its `cleanup()` first, and hooks run in reverse
// registration order, so this still runs BEFORE unmount — unchanged from the per-describe form.
afterEach(() => vi.restoreAllMocks());

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
  document.querySelector<HTMLButtonElement>('[data-testid="judge-skip"]');

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

  test("the other side keeps its own requirement, not the crucible's minimum", async () => {
    const pair = { left: entry(1), right: entry(2), watchSeconds: { left: 1, right: 3 } } as never;
    renderWithProviders(
      <CrucibleJudgingUI pair={pair} minViewSeconds={6} onVote={vi.fn()} onSkip={vi.fn()} />
    );
    await expectBothCardsRendered();

    // 1750ms each: past the left's 1s, short of the right's 3s and of the 6s minimum.
    await advance(0, 2);
    await advance(1, 2);

    await vi.waitFor(() => expect(label('left')).toMatch(/^Vote/));
    expect(label('right')).toMatch(/^Watch 2s more/);
    expect(voteButton('right')!.disabled).toBe(true);
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

  test('two clicks on an image inside the feedback delay cast one vote', async () => {
    const onVote = vi.fn();
    renderWithProviders(
      <CrucibleJudgingUI
        pair={{ left: entry(1, 'image'), right: entry(2, 'image') } as never}
        onVote={onVote}
        onSkip={vi.fn()}
      />
    );
    const imageCard = () =>
      document.querySelector<HTMLElement>('[aria-label="Vote for left image"]');
    await vi.waitFor(() => expect(voteButton('left')!.disabled).toBe(false));

    imageCard()!.click();
    imageCard()!.click();
    await pastFeedbackDelay();

    expect(onVote).toHaveBeenCalledTimes(1);
    expect(onVote.mock.calls[0][0]).toBe(1);
  });

  test('onVoteCast reports the chosen side before the vote lands', async () => {
    const onVote = vi.fn();
    const onVoteCast = vi.fn();
    renderWithProviders(
      <CrucibleJudgingUI
        pair={pairOf(1, 2)}
        onVote={onVote}
        onVoteCast={onVoteCast}
        onSkip={vi.fn()}
      />
    );
    await expectBothCardsRendered();

    voteButton('right')!.click();

    expect(onVoteCast).toHaveBeenCalledTimes(1);
    expect(onVoteCast).toHaveBeenCalledWith('right');
    expect(onVote).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onVote).toHaveBeenCalledTimes(1));
    expect(onVoteCast).toHaveBeenCalledTimes(1);
  });

  test('a click on a video does not vote; the vote button still does', async () => {
    const onVote = vi.fn();
    renderWithProviders(<CrucibleJudgingUI pair={pairOf(1, 2)} onVote={onVote} onSkip={vi.fn()} />);
    await expectBothCardsRendered();
    expect(voteButton('left')!.disabled, 'precondition: voting is open').toBe(false);

    video('left').click();
    await pastFeedbackDelay();
    expect(onVote).not.toHaveBeenCalled();

    voteButton('left')!.click();
    await vi.waitFor(() => expect(onVote).toHaveBeenCalledTimes(1));
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
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (
      this: HTMLMediaElement
    ) {
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
  });

  test('a clip that starts playing pauses the other one', async () => {
    renderWithProviders(
      <CrucibleJudgingUI pair={pairOf(1, 2)} onVote={vi.fn()} onSkip={vi.fn()} />
    );
    await expectBothCardsRendered();

    // This test's hidden precondition is that NEITHER clip is already the playing one — the
    // dispatch below has to CHANGE `playingSide` for the other card's effect to re-run. A stray
    // mouse hover played a clip and set it first, which is what reds this test in CI; the
    // suppressor at the top of this file is what holds the precondition.
    //
    // Spied on the PROTOTYPE rather than on the two elements, and read through `sidesCalledOn`: an
    // instance spy is bound to the node it was installed on, so a <video> replaced between `spyOn`
    // and the pause would leave it on a detached node where it can never be called — a mechanism
    // that is NOT what reds this test (nothing here moves `JudgingMedia`'s `${pairKey}:${attempt}`
    // key) but whose failure is indistinguishable from the real one, so it is worth not having.
    // Installed call-through, unlike the `spies()` helper below, which stubs `pause` out: the
    // instance spies this replaces also let the real (no-op, never-played) `pause` run.
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause');
    video('left').dispatchEvent(new Event('play'));

    await vi.waitFor(() => expect(sidesCalledOn(pause)).toContain('right'));
    expect(sidesCalledOn(pause)).not.toContain('left');
  });

  test('an uninvited mouse hover cannot start a clip', async () => {
    // GUARD for the stray-pointer suppressor at the top of this file, not a product claim: with
    // the suppressor removed this fails, and the two tests it protects go back to being
    // intermittently red for a reason nothing reports. The component really does play a clip on a
    // mouse enter — verified by removing the suppressor and watching this go red — so this is a
    // statement about the suppressor's reach, and the positive control below is what stops it
    // passing because the spy sees nothing at all.
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    renderWithProviders(
      <CrucibleJudgingUI pair={pairOf(1, 2)} onVote={vi.fn()} onSkip={vi.fn()} />
    );
    await expectBothCardsRendered();

    video('left').dispatchEvent(
      new PointerEvent('pointerover', { pointerType: 'mouse', bubbles: true })
    );
    await afterPassiveEffects();
    expect(sidesCalledOn(play)).toEqual([]);

    await video('left').play();
    expect(sidesCalledOn(play)).toEqual(['left']);
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

    // The happens-before this absence needs, in two steps, in place of a wall-clock sleep.
    // `expectBothCardsRendered` only reads each card's OWN load state, which flips a render before
    // the pair knows about it — that gap is what the sleep was covering. With no rule the watch
    // gate is open from the first render, so `voteLocked` reduces to `!mediaReady`: an enabled vote
    // button IS the commit in which the sequence would have been started. The effect that would
    // start it is a PASSIVE effect of that commit, which is why the drain below is also needed —
    // observing a committed DOM does not on its own order anything after that commit's effects.
    // Labelled a precondition so a gate that never opens does not read as the subject failing.
    await vi.waitFor(() =>
      expect(voteButton('left')!.disabled, 'precondition: the vote gate never opened').toBe(false)
    );
    await afterPassiveEffects();

    // Scoped to THIS pair, and reporting WHICH side. The spy is on `HTMLMediaElement.prototype`,
    // so a bare `expect(play).not.toHaveBeenCalled()` also counts a `play()` from any other media
    // element on the page, and reports a count that cannot say what played. That opacity is what
    // made this red undiagnosable for three days; naming the side is what identified it as the
    // component's own clip, and from there as the stray hover the suppressor above now drops.
    expect(sidesCalledOn(play)).toEqual([]);

    // Positive control, because a reported zero is indistinguishable from an instrument wired to
    // nothing: show the same filter CAN see a play on this pair before trusting the empty one.
    await video('left').play();
    expect(sidesCalledOn(play)).toEqual(['left']);
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
    // KNOWN FOLLOW-UP, deliberately left here: this is the same absence-after-a-wall-clock-sleep
    // shape the test above was repaired for, and it should become the same
    // `vi.waitFor` + `afterPassiveEffects()` pair. It was not red, and rewriting a passing test's
    // ordering is a separate change from the flake repair — folding it in would make a bisect of
    // either one ambiguous. The other two sleeps in this file (`pastFeedbackDelay`, `settle`) are
    // a weaker case: they wait out a real product timer rather than a render.
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

  // 4.04s against a 3s rule: inside the 35% tolerance, and the cap is reached on the fourth click
  // while the playhead only wraps on the fifth.
  const PAST_CAP_CLIP_SECONDS = 4.04;

  test('a clip a little past the rule plays on to its end, without delaying the vote', async () => {
    const { pause } = spies();
    clipDurations.set(srcOf(2), PAST_CAP_CLIP_SECONDS);
    renderWithProviders(
      <CrucibleJudgingUI pair={pairOf(1, 2)} minViewSeconds={3} onVote={vi.fn()} onSkip={vi.fn()} />
    );
    await expectBothCardsRendered();

    await advance(0, 4);
    await advance(1, 4);

    await vi.waitFor(() => expect(voteButton('left')!.disabled).toBe(false));
    await afterPassiveEffects();
    expect(sidesCalledOn(pause)).not.toContain('right');

    await advance(1, 1);

    await vi.waitFor(() => expect(sidesCalledOn(pause)).toContain('right'));
  });

  test('the right clip waits for a left clip a little past the rule to finish', async () => {
    const { play, pause } = spies();
    clipDurations.set(srcOf(1), PAST_CAP_CLIP_SECONDS);
    renderWithProviders(
      <CrucibleJudgingUI pair={pairOf(1, 2)} minViewSeconds={3} onVote={vi.fn()} onSkip={vi.fn()} />
    );
    await expectBothCardsRendered();

    await advance(0, 4);
    await vi.waitFor(() => expect(label('left')).toMatch(/^Vote/));
    await afterPassiveEffects();
    expect(sidesCalledOn(play)).not.toContain('right');
    expect(sidesCalledOn(pause)).not.toContain('left');

    await advance(0, 1);

    await vi.waitFor(() => expect(sidesCalledOn(play)).toContain('right'));
    expect(sidesCalledOn(pause)).toContain('left');
  });

  test('a skip to the end of a clip a little past the rule unlocks nothing', async () => {
    // Negative control: within the tolerance, a wrap ends playback; it never stands in for the rule.
    spies();
    clipDurations.set(srcOf(1), PAST_CAP_CLIP_SECONDS);
    playheads.set(srcOf(1), 3.9);
    renderWithProviders(
      <CrucibleJudgingUI pair={pairOf(1, 2)} minViewSeconds={3} onVote={vi.fn()} onSkip={vi.fn()} />
    );
    await expectBothCardsRendered();

    await advance(0, 1);

    await vi.waitFor(() => expect(playheads.get(srcOf(1))).toBeLessThan(1));
    expect(label('left')).toMatch(/^Watch \d+s more/);
  });
});

describe('CrucibleJudgingUI — paused under the briefing', () => {
  function PausedHarness({
    initiallyPaused,
    minViewSeconds = 3,
  }: {
    initiallyPaused: boolean;
    minViewSeconds?: number;
  }) {
    const [paused, setPaused] = useState(initiallyPaused);
    return (
      <>
        <button type="button" data-testid="toggle-paused" onClick={() => setPaused((p) => !p)}>
          toggle
        </button>
        <CrucibleJudgingUI
          pair={pairOf(1, 2)}
          minViewSeconds={minViewSeconds}
          paused={paused}
          onVote={vi.fn()}
          onSkip={vi.fn()}
        />
      </>
    );
  }
  const togglePaused = () =>
    document.querySelector<HTMLButtonElement>('[data-testid="toggle-paused"]')!.click();

  test('plays nothing and counts no playback until unpaused, then starts on the left', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    renderWithProviders(<PausedHarness initiallyPaused />);
    await expectBothCardsRendered();

    // Enough playback to clear the rule, were it counted.
    await advance(0, 4);
    await afterPassiveEffects();
    expect(label('left')).toMatch(/^Watch 3s more/);
    expect(sidesCalledOn(play)).toEqual([]);

    togglePaused();

    await vi.waitFor(() => expect(sidesCalledOn(play)).toEqual(['left']));
    await advance(0, 4);
    await vi.waitFor(() => expect(label('left')).toMatch(/^Vote/));
  });

  test('pausing stops the autoplaying clip', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    renderWithProviders(<PausedHarness initiallyPaused={false} />);
    await expectBothCardsRendered();
    await vi.waitFor(() => expect(sidesCalledOn(play)).toEqual(['left']));
    pause.mockClear();

    togglePaused();

    await vi.waitFor(() => expect(sidesCalledOn(pause)).toContain('left'));
  });

  test('pausing also stops a clip the judge started, outside any sequence', async () => {
    // No rule, so no sequence: the only pause comes from `paused` itself.
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    renderWithProviders(<PausedHarness initiallyPaused={false} minViewSeconds={0} />);
    await expectBothCardsRendered();
    await afterPassiveEffects();
    pause.mockClear();

    togglePaused();

    await vi.waitFor(() => expect(sidesCalledOn(pause)).toEqual(['left', 'right']));
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

describe('CrucibleJudgingUI — keys the arena does not own', () => {
  const pressOn = (target: Element, key: string, code: string) => {
    const event = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 400));
  const briefing = () => document.querySelector('[role="dialog"]');

  function BriefingHarness({ onVote, onSkip }: { onVote: OnVote; onSkip: () => void }) {
    const [open, setOpen] = useState(true);
    return (
      <>
        <div data-judge-chrome>
          <button type="button" data-testid="chrome-button">
            Rules
          </button>
        </div>
        <CrucibleJudgingUI pair={pairOf(1, 2)} onVote={onVote} onSkip={onSkip} />
        {open && (
          <CrucibleJudgingBriefing
            name="Test crucible"
            theme=""
            image={null}
            contentType={'video' as never}
            nsfwLevel={1}
            browsingLevel={1}
            onDismiss={() => setOpen(false)}
          />
        )}
      </>
    );
  }

  test('an arrow key behind the briefing casts the vote and closes the briefing', async () => {
    const onVote = vi.fn();
    renderWithProviders(<BriefingHarness onVote={onVote} onSkip={vi.fn()} />);
    await expectBothCardsRendered();
    expect(briefing()).toBeTruthy();

    pressOn(document.documentElement, 'ArrowLeft', 'ArrowLeft');

    await vi.waitFor(() => expect(briefing()).toBeNull());
    await vi.waitFor(() => expect(onVote).toHaveBeenCalledTimes(1));
    expect(onVote.mock.calls[0][0]).toBe(1);
  });

  test('the briefing focuses its start button and is modal', async () => {
    renderWithProviders(<BriefingHarness onVote={vi.fn()} onSkip={vi.fn()} />);
    await vi.waitFor(() => expect(briefing()).toBeTruthy());

    expect(briefing()!.getAttribute('aria-modal')).toBe('true');
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Start judging'));
  });

  test('Space on the focused start button closes the briefing without skipping', async () => {
    const onSkip = vi.fn();
    renderWithProviders(<BriefingHarness onVote={vi.fn()} onSkip={onSkip} />);
    await expectBothCardsRendered();
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Start judging'));

    const event = pressOn(document.activeElement!, ' ', 'Space');

    await vi.waitFor(() => expect(briefing()).toBeNull());
    await settle();
    expect(onSkip).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  test('Space on a page header control is left to that control', async () => {
    const onSkip = vi.fn();
    renderWithProviders(<BriefingHarness onVote={vi.fn()} onSkip={onSkip} />);
    await expectBothCardsRendered();
    const chromeButton = document.querySelector('[data-testid="chrome-button"]')!;

    const event = pressOn(chromeButton, ' ', 'Space');
    await settle();

    expect(onSkip).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);

    // Negative control: the same press with focus nowhere in particular still skips.
    pressOn(document.body, ' ', 'Space');
    await vi.waitFor(() => expect(onSkip).toHaveBeenCalledTimes(1));
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
