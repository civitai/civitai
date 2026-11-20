<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { applyAction, deserialize, enhance } from '$app/forms';
  import { dev } from '$app/environment';
  import { beforeNavigate, invalidate } from '$app/navigation';
  import type { SubmitFunction } from '@sveltejs/kit';
  import BlockReasons from './BlockReasons.svelte';
  import ApprenticeMeter from './ApprenticeMeter.svelte';
  import RailSheet from './RailSheet.svelte';
  import CheckpointRecap from './CheckpointRecap.svelte';
  import GuideDialog from './GuideDialog.svelte';
  import ImageStage from './ImageStage.svelte';
  import SettledCard from './SettledCard.svelte';
  import LevelToast from './LevelToast.svelte';
  import RulingToast from './RulingToast.svelte';
  import QueueClear from './QueueClear.svelte';
  import RankUpDialog from './RankUpDialog.svelte';
  import ResetNotice from './ResetNotice.svelte';
  import Countdown from '$lib/Countdown.svelte';
  import Icon from '$lib/Icon.svelte';
  import AnswerPill from '$lib/AnswerPill.svelte';
  import '$lib/answer-row.css';
  import { sound } from '$lib/sound';
  import WatchMeta from '$lib/WatchMeta.svelte';
  import { heartsLeft, landVote, pendingGoldVotes, pendingVotes, watchStrip, withVotesSent } from '$lib/chrome';
  import { leaveAction, watchInProgress } from '$lib/leave-guard';
  import PlayRail from './PlayRail.svelte';
  import { answerForKey, answerForKeyPress, optionsOnScreen, spaceSkips } from './keys';
  import { votesSent } from '$lib/votes-sent.svelte';
  import { whatsNewView } from '$lib/whats-new-dismiss.svelte';
  import { dismissible } from '$lib/optimistic-dismiss.svelte';
  import { noticeKey } from './level-notice';
  import { closeGuide, guideShowing, openGuide, settleGuide, type GuideState } from './guide-dialog';
  import {
    MAX_EXCLUDED,
    createItemBuffer,
    createSerialQueue,
    createVoteTracker,
    postVote,
    refillCount,
    refusalNote,
    skillCheckCue,
    type PickedItem,
  } from './optimistic';
  import { BLOCKED_ANSWER, BLOCK_REASONS, asksBlockReason, type BlockReason } from '$lib/block-reasons';
  import type { ActionData, PageData } from './$types';
  import type { PlayerStatsSignal } from '$lib/server/live/announce';
  import { connectSignals, joinTopic, onSignal } from '$lib/signals';
  import { liveStatus } from '$lib/live-status.svelte';
  import {
    PLAYER_STATS_EVENT,
    QUEUE_DROP_EVENT,
    acceptsStats,
    dropsForPlayer,
    queueTopic,
    readQueueDrops,
  } from '$lib/live-events';

  type PlayerData = Exclude<PageData, { mode: 'inquisitor' }>;
  let { data, form }: { data: PlayerData; form: ActionData } = $props();
  // The latest stats signal, taken only when it is newer than the page's data and counts every vote the page shows.
  let live = $state.raw<PlayerStatsSignal | null>(null);
  let shown = $derived(
    data.mode === 'queue' && live && live.at > data.live.at
      ? { ...data, status: live.status, daily: live.daily }
      : data
  );
  let submitting = $state(false);
  let answers = $state<HTMLFormElement>();
  let skipForm = $state<HTMLFormElement>();
  // What is on screen. Right after a vote it is the item fetched ahead (`local`), not what `load` returns, so the next
  // image never waits for the vote to land; `local` is dropped whenever the page must show the server's own view.
  let local = $state<PickedItem | null>(null);
  let view = $derived.by((): PickedItem | null => {
    if (data.mode !== 'queue') return null;
    if (local) return local;
    return data.item && data.question
      ? { item: data.item, question: data.question, banner: data.banner, category: data.category }
      : null;
  });
  let yesNo = $derived(
    data.mode === 'queue'
      ? view?.question.kind === 'bool'
      : data.apprentice.kind === 'question' && data.apprentice.item.kind === 'yesno'
  );
  // The first-visit guide is dismissed once and recorded; the Guide button reopens it without recording anything more.
  const guide = $state<GuideState>({ reopened: false, dismissed: false });
  let guideOpen = $derived(guideShowing(data.showGuide, guide));
  // A title shows on hover and focus only; touch players get the same text from the Guide button.
  let levelHint = $derived(
    new Map(data.ratingGuide.map((entry) => [String(entry.level), `${entry.label}: ${entry.description}`]))
  );
  // The answer being sent, kept highlighted until the next item arrives.
  let picked = $state<string | null>(null);
  let failedItem = $state<string | null>(null);
  let imageFailed = $derived(!!view && failedItem === view.item.key);
  let reasonItem = $state<string | null>(null);
  let choosingReason = $derived(!!view && reasonItem === view.item.key);
  // The item on screen that other players settled: it stays up under a card, locked, until the player moves on.
  let settledItem = $state<string | null>(null);
  let settledOnScreen = $derived(!!view && settledItem === view.item.key);
  let settledReady = $state(false);
  let blockReason = $state<BlockReason | null>(null);
  // The ruling toast floats over the image stage; it is only an alert, so the answers stay live under it.
  const rulingNotice = dismissible(
    () => (data.notices.length > 0 ? data.notices.map((notice) => notice.key).join(' ') : null),
    { noticeFailed: true }
  );
  const careerReset = dismissible(() => (data.resetNotice ? 'reset' : null), { resetNoticeFailed: true });
  // A dialog is up: it owns the keyboard, so the answer keys and Space do nothing behind it.
  const whatsNew = whatsNewView();
  // Votes posted in the background that the page's data does not hold yet; the Watch and the header count them at once.
  // A vote that answers after the page is gone must not take from the next visit's count.
  const inFlight = votesSent();
  let alive = true;
  onDestroy(() => {
    alive = false;
    inFlight.count = 0;
    inFlight.landed = 0;
    inFlight.landedOn = null;
    inFlight.goldless = 0;
  });
  // The level card and the rank-up dialog; `showing` decides whether one is drawn, while the `noticeShown` fields keep
  // following `levelNotice`, the server's notice, so an answer given right after "Onward" still records the card it appeared with.
  const progress = dismissible(() => (data.progress ? noticeKey(data.progress) : null), { progressFailed: true });
  let dialogOpen = $derived(whatsNew.showing || guideOpen || (data.progress?.kind === 'rank' && progress.showing));
  let levelNotice = $derived(!guideOpen && data.progress?.kind === 'level' ? data.progress : null);

  // Header-menu dialogs (feedback, restart career) don't set `dialogOpen`; the reason picker is this page's own.
  const headerDialogOpen = () =>
    !!document.querySelector(
      '[role="dialog"][aria-modal="true"]:not([aria-labelledby="block-reason-title"])'
    );

  // The number keys answer in option order (a yes/no question also takes Y and N), in the queue and the apprenticeship alike,
  // and Space skips a queue item, even while an answer button has focus (the browser would otherwise press it); in the
  // apprenticeship Space is left to the browser. Typing in a field or holding a modifier is left alone.
  function onkeydown(event: KeyboardEvent) {
    if (headerDialogOpen()) return;
    if (settledOnScreen) {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape') {
        event.preventDefault();
        if (!event.repeat) continueFromSettled();
      }
      return;
    }
    if (choosingReason) {
      const reason = answerForKey([...BLOCK_REASONS], event.key);
      if (reason && !event.ctrlKey && !event.metaKey && !event.altKey) pickReason(reason as BlockReason);
      return;
    }
    const screen = {
      question: view?.question,
      apprentice: data.mode === 'apprentice' ? data.apprentice : null,
    };
    const options = optionsOnScreen(screen);
    if (event.repeat || dialogOpen || !options || submitting) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable], header')) return;
    if (event.key === ' ') {
      if (!spaceSkips(screen)) return;
      event.preventDefault();
      skipForm?.requestSubmit();
      return;
    }
    if (imageFailed) return;
    const value = answerForKeyPress(options, event.key, yesNo);
    if (value) answers?.querySelector<HTMLButtonElement>(`button[value="${value}"]`)?.click();
  }

  function pickReason(reason: BlockReason) {
    blockReason = reason;
    reasonItem = null;
    const blocked = answers?.querySelector<HTMLButtonElement>(`button[value="${BLOCKED_ANSWER}"]`);
    if (blocked) answers?.requestSubmit(blocked);
  }

  // The header owns the sound engine's setup, so the saved choice is read once it has run.
  let soundMuted = $state(false);
  onMount(() => {
    void tick().then(() => (soundMuted = sound.muted));
  });
  let railSheetOpen = $state(false);

  function toggleSound() {
    soundMuted = !soundMuted;
    sound.setMuted(soundMuted);
  }

  function onApprenticeAnswer(correct: boolean) {
    sound.play(correct ? 'trial-correct' : 'trial-wrong');
  }

  const submitApprentice: SubmitFunction = ({ submitter }) => {
    submitting = true;
    picked = answerOf(submitter);
    if (picked) sound.play('press');
    return async ({ result, update }) => {
      try {
        if (result.type === 'success' && typeof result.data?.correct === 'boolean') {
          onApprenticeAnswer(result.data.correct);
        }
        await update();
        if (result.type === 'failure') await invalidate('app:play');
      } finally {
        submitting = false;
        picked = null;
      }
    };
  };

  const submitCheckpoint: SubmitFunction = () => {
    submitting = true;
    return async ({ result, update }) => {
      try {
        await update();
        if (result.type === 'failure') await invalidate('app:play');
      } finally {
        submitting = false;
      }
    };
  };

  // "I understand" closes the guide at once; the dismissal is recorded in the background, and only a refused one reloads.
  const submitGuide: SubmitFunction = () => {
    const before = closeGuide(guide);
    return async ({ result, update }) => {
      const stored = result.type === 'success';
      settleGuide(guide, stored, before);
      if (!stored) await update();
    };
  };

  const answerOf = (submitter: HTMLElement | null) =>
    submitter instanceof HTMLButtonElement && submitter.name === 'answer' ? submitter.value : null;

  const submit: SubmitFunction = ({ submitter, formData }) => {
    submitting = true;
    picked = answerOf(submitter);
    if (picked === BLOCKED_ANSWER && blockReason) formData.set('blockReason', blockReason);
    blockReason = null;
    if (picked) sound.play('press');
    return async ({ result, update }) => {
      try {
        await update();
        // A refused answer doesn't re-run `load`; refetch or the refused item stays on screen.
        if (result.type === 'failure') await invalidate('app:play');
      } finally {
        submitting = false;
        picked = null;
      }
    };
  };

  // The next items, fetched while this one is judged, so a vote can move on at once. All of them have their image requested
  // into the browser cache; the first few are also decoded and held, and only a decoded head is swapped to, so a swap never
  // shows a blank stage. Consuming one promotes the next downloaded item into the decoded window.
  const buffer = createItemBuffer();
  let buffered = $state(0);
  let refilling = $state(false);
  // Bumped whenever the buffer is thrown away, so a request still in flight cannot refill it afterwards.
  let epoch = 0;
  // The current item a refill came back empty for: ask again only once the item on screen changes.
  let emptyFor: string | undefined;
  // Holds each decoded image, by item key, so the browser keeps it ready until the item is shown.
  const preloaded = new Map<string, HTMLImageElement>();
  // The downloads under way, held only until they finish: the bytes then sit in the HTTP cache for the `<img>` that shows
  // the same address, and no decoded bitmap is kept for the items still waiting.
  const downloading = new Map<string, HTMLImageElement>();
  let note = $state<string | null>(null);
  let cooling = $state(false);
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  const tracker = createVoteTracker();
  // A new image takes this long to be seen; an answer sooner than that is a stray press, not a judgment of it.
  type FinishOptions = Parameters<Exclude<Awaited<ReturnType<SubmitFunction>>, void>>[0];
  const SETTLE_MS = 250;
  const NOTE_MS = 5000;

  const JUDGED_NOTICE = 'You have already judged this one.';
  const syncBuffer = () => {
    buffered = buffer.size;
    decodeAhead();
  };
  function dropBuffered(key: string) {
    buffer.drop(key);
    preloaded.delete(key);
    downloading.delete(key);
    syncBuffer();
  }
  function clearBuffer() {
    epoch += 1;
    buffer.clear();
    preloaded.clear();
    downloading.clear();
    syncBuffer();
  }

  // Requests the image at its display address, at low priority, so the browser caches exactly what the stage will ask for.
  function download(entry: PickedItem, mine: number) {
    const key = entry.item.key;
    const image = new Image();
    image.fetchPriority = 'low';
    image.onload = () => downloading.delete(key);
    image.onerror = () => {
      downloading.delete(key);
      if (mine !== epoch) return;
      tracker.avoid(entry.item.id);
      dropBuffered(key);
    };
    downloading.set(key, image);
    image.src = entry.item.src;
  }

  // Decodes the items at the front of the buffer that are not yet ready, so the image is a bitmap by the time it is shown.
  // One that will not decode is left out of the next requests instead of being offered again.
  function decodeAhead() {
    const mine = epoch;
    for (const entry of buffer.toDecode()) {
      const key = entry.item.key;
      const image = new Image();
      image.src = entry.item.src;
      void image
        .decode()
        .then(() => {
          if (mine !== epoch || !buffer.markDecoded(key)) return;
          preloaded.set(key, image);
        })
        .catch(() => {
          if (mine !== epoch) return;
          tracker.avoid(entry.item.id);
          dropBuffered(key);
        });
    }
  }

  // Primitives, so reloading the page data after a vote (same item, same flags) does not re-run the refill and drop
  // items that are already loaded. The key, not the token: the token is sealed afresh each time an item is served.
  let currentKey = $derived(view?.item.key);
  let paused = $derived(Boolean(data.lockoutSeconds || data.muted || data.resetPending));

  // The server's feed can land on a buffered item (after a plain form post): it is on screen now, not ahead. It can
  // also land on one already judged whose vote is still in flight: that is not shown again, the buffered item is.
  $effect(() => {
    const key = currentKey;
    if (!key) return;
    untrack(() => {
      dropBuffered(key);
      if (local || !tracker.has(key)) return;
      const next = buffer.next();
      if (!next) return;
      preloaded.delete(next.item.key);
      local = next;
      syncBuffer();
    });
  });

  $effect(() => {
    const current = currentKey;
    void buffered;
    if (!current || paused || refilling || emptyFor === current) return;
    if (untrack(() => buffer.needsRefill())) void refill(current);
  });

  async function refill(current: string) {
    const mine = epoch;
    refilling = true;
    let added = 0;
    try {
      const shown = untrack(() => view?.item.id) ?? '';
      const after = [...tracker.excluded(shown), ...buffer.tokens()]
        .slice(-MAX_EXCLUDED)
        .map((token) => `after=${encodeURIComponent(token)}`);
      // What the yes/no stretch counts as already judged: votes in flight, the item on screen, then the buffer. Skipped and
      // unloadable items are in `after` (left out) but never here, since they never get a vote.
      const ahead = [...tracker.voting().filter((token) => token !== shown), shown, ...buffer.tokens()]
        .filter(Boolean)
        .slice(-MAX_EXCLUDED)
        .map((token) => `ahead=${encodeURIComponent(token)}`);
      const count = refillCount(buffer.size);
      const response = await fetch(`/play/next?count=${count}&${after.join('&')}&${ahead.join('&')}`, {
        headers: { accept: 'application/json' },
      });
      const body: { items?: PickedItem[] } | null = response.ok ? await response.json() : null;
      for (const entry of body?.items ?? []) {
        if (mine !== epoch) return;
        if (dropped.has(entry.item.live)) continue;
        if (buffer.enqueue(entry, (key) => tracker.has(key) || key === currentKey)) {
          download(entry, mine);
          added += 1;
        }
      }
      if (added) syncBuffer();
    } catch {
      // Nothing buffered for this round; the vote falls back to the form post.
    } finally {
      if (mine === epoch) {
        if (!added) emptyFor = current;
        refilling = false;
      }
    }
  }

  // The server's own view wins whenever it has something to say instead of an item.
  $effect(() => {
    if (paused) {
      local = null;
      clearBuffer();
      refilling = false;
    }
  });

  // A right hidden-check answer while a smite weighs on the player: a short cue that it counted toward the next heart.
  let cue = $state<string | null>(null);
  let cueTimer: ReturnType<typeof setTimeout> | undefined;
  const CUE_MS = 2500;
  function cheer(result: Record<string, unknown> | undefined, smitesBefore: number) {
    const next = skillCheckCue(result, smitesBefore);
    if (!next) return;
    cue = next;
    clearTimeout(cueTimer);
    cueTimer = setTimeout(() => (cue = null), CUE_MS);
  }
  function clearCue() {
    cue = null;
    clearTimeout(cueTimer);
  }
  onDestroy(() => {
    clearTimeout(noteTimer);
    clearTimeout(cueTimer);
  });

  // A refused background vote's note stays until the next judgment or until dismissed: the player has moved on by the time
  // it arrives, and a note that vanished after five seconds let a press pass for a counted vote.
  let sticky = $state(false);
  function tell(message: string) {
    clearCue();
    note = message;
    sticky = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => (note = null), NOTE_MS);
  }
  function stick(message: string) {
    clearCue();
    note = message;
    sticky = true;
    clearTimeout(noteTimer);
  }
  function unstick() {
    if (!sticky) return;
    sticky = false;
    note = null;
  }

  // Background votes go one at a time, in the order they were answered: this page posts one vote at a time.
  const votes = createSerialQueue();
  const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

  function post(action: URL, body: FormData, key: string, counted: boolean) {
    // Read at the press: by the time the answer lands, the page data may already hold this vote's effect.
    const smitesBefore = shown.status.smites;
    const uncount = () => {
      if (counted && alive) inFlight.count = Math.max(0, inFlight.count - 1);
      counted = false;
    };
    // Set when the server counted a stale judgment toward the Watch: it lands on the Watch but adds no gold.
    let paysGold = true;
    return postVote(key, {
      queue: votes,
      tracker,
      wait,
      send: async (signal) => {
        try {
          const response = await fetch(action, {
            method: 'POST',
            body,
            headers: { accept: 'application/json', 'x-sveltekit-action': 'true' },
            signal,
          });
          const result = deserialize(await response.text());
          if (result.type === 'redirect' || result.type === 'error') await applyAction(result);
          return { reached: true, result };
        } catch {
          // Keeps the lost-connection notice.
          return { reached: false, result: null };
        }
      },
      onFailure: (outcome) => {
        if (outcome.watchCounted) paysGold = false;
        else uncount();
        const message = refusalNote(outcome);
        if (message) stick(message);
        dropBuffered(key);
        if (outcome.resync) {
          local = null;
          clearBuffer();
          refilling = false;
        }
      },
      // The page's own data (status, rewards, level notices) is read again once the last vote in flight has landed; each vote
      // stays counted against the data on screen until the refreshed data, which holds it, replaces it.
      onSuccess: (result) => cheer(result, smitesBefore),
      onSettled: async () => {
        if (counted && alive) landVote(inFlight, shown.daily, { paysGold });
        counted = false;
        // Votes post one at a time, so a vote still unlanded settles after this one and reads the page then. Reading it now
        // as well would only be discarded when that read starts, and while reads kept replacing each other the status froze.
        if (inFlight.count > 0) return;
        await invalidate('app:play').catch(() => {});
      },
    });
  }

  // The plain form post: once the page has the server's next item, what was on screen ahead of it goes. The item counts
  // as sent from here on, so a reload that serves it again (its vote still in flight) is not posted a second time.
  const submitAndResync = (input: Parameters<SubmitFunction>[0], key: string, token: string): ReturnType<SubmitFunction> => {
    tracker.claim(key, token, input.action.search.startsWith('?/vote'));
    const finish = submit(input) as (options: FinishOptions) => Promise<void>;
    return async (options) => {
      await finish(options);
      local = null;
      tracker.settle(key);
      const { result } = options;
      const settled = result.type === 'success' || (result.type === 'failure' && result.status === 409);
      if (!settled) tracker.release(key);
    };
  };

  // A vote or a skip moves on at once to the item buffered ahead and posts in the background. Without that item (or without
  // JS) the form posts and the page reloads as before. An item already sent is never posted again, whatever token it
  // came back with: the notice says so, and the page is read again if nothing is left in flight to do it.
  const submitJudgment: SubmitFunction = (input) => {
    const shown = view;
    const token = String(input.formData.get('item') ?? '');
    if (!shown || !token) return submit(input);
    const key = shown.item.key;
    if (tracker.has(key)) {
      input.cancel();
      tell(JUDGED_NOTICE);
      if (!tracker.pending) void invalidate('app:play');
      return;
    }
    const next = buffer.peek();
    if (!next) return submitAndResync(input, key, token);
    input.cancel();
    if (cooling || !tracker.claim(key, token, input.action.search.startsWith('?/vote'))) return;
    unstick();
    const answer = answerOf(input.submitter);
    if (answer === BLOCKED_ANSWER && blockReason) input.formData.set('blockReason', blockReason);
    blockReason = null;
    if (answer) sound.play('press');
    local = buffer.next();
    preloaded.delete(next.item.key);
    syncBuffer();
    cooling = true;
    setTimeout(() => (cooling = false), SETTLE_MS);
    const isVote = input.action.search.startsWith('?/vote');
    if (isVote) inFlight.count += 1;
    void post(input.action, input.formData, key, isVote);
  };

  // Long enough that a click or key already on its way when the card appears cannot dismiss it.
  const SETTLED_GUARD_MS = 600;
  let settledTimer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(settledTimer));

  // Moves on the way Skip does: to the item fetched ahead, or by the form post when none is ready.
  function continueFromSettled() {
    if (!settledOnScreen || !settledReady) return;
    settledItem = null;
    skipForm?.requestSubmit();
  }

  // Live keys dropped lately: a refill or reload already in flight when the drop came must not bring the item back.
  const dropped = new Set<string>();
  const MAX_DROPPED = 200;

  // Items other players settled (or moved past this player's stages) leave the buffer unseen. The one on screen is not
  // swapped under the player's hand: it is locked under a card they dismiss, so no press lands on the next image by accident.
  function onDrops(payload: unknown) {
    if (data.mode !== 'queue') return;
    const stages = data.live.stages;
    const gone = new Set(
      readQueueDrops(payload)
        .filter((drop) => dropsForPlayer(drop, stages))
        .map((drop) => drop.k)
    );
    if (gone.size === 0) return;
    for (const k of gone) dropped.add(k);
    while (dropped.size > MAX_DROPPED) dropped.delete(dropped.values().next().value!);
    for (const key of buffer.dropLive(gone)) {
      preloaded.delete(key);
      downloading.delete(key);
    }
    syncBuffer();
    const onScreen = view?.item;
    if (!onScreen || !gone.has(onScreen.live) || tracker.has(onScreen.key) || settledOnScreen) return;
    reasonItem = null;
    settledItem = onScreen.key;
    settledReady = false;
    clearTimeout(settledTimer);
    settledTimer = setTimeout(() => (settledReady = true), SETTLED_GUARD_MS);
  }

  function onStats(payload: unknown) {
    const signal = payload as PlayerStatsSignal | null;
    if (data.mode !== 'queue' || !signal?.status || !signal.daily) return;
    const daily = shown.mode === 'queue' ? shown.daily : null;
    if (!daily) return;
    const at = Math.max(data.live.at, live?.at ?? 0);
    const votes = daily.votes + pendingVotes(inFlight, daily);
    if (acceptsStats(signal, { at, votes, inFlight: inFlight.count })) live = signal;
  }

  onMount(() => {
    connectSignals();
    const offDrops = onSignal(QUEUE_DROP_EVENT, onDrops);
    // Dev builds only: settles the item on screen as a drop signal would, for browser tests without a signal service.
    if (dev) {
      (window as Window & { __knightsSettleOnScreen?: () => void }).__knightsSettleOnScreen = () => {
        if (view) onDrops({ drops: [{ k: view.item.live, to: null }] });
      };
    }
    const offStats = onSignal(PLAYER_STATS_EVENT, onStats);
    return () => {
      offDrops();
      offStats();
    };
  });

  const headerStatus = liveStatus();
  $effect(() => {
    headerStatus.current = shown === data ? null : shown.status;
  });
  onDestroy(() => (headerStatus.current = null));

  // A primitive, so a page reload with the same stages does not leave and rejoin the topics.
  let stageList = $derived(data.mode === 'queue' ? data.live.stages.join(',') : '');
  $effect(() => {
    const leave = stageList ? stageList.split(',').map((stage) => joinTopic(queueTopic(stage))) : [];
    return () => leave.forEach((left) => left());
  });

  let strip = $derived(shown.mode === 'queue' ? watchStrip(withVotesSent(shown.daily, pendingVotes(inFlight, shown.daily))) : null);
  let watching = $derived(shown.mode === 'queue' && !paused && Boolean(view) && watchInProgress(shown.daily));

  beforeNavigate(({ cancel, type, to }) => {
    const action = leaveAction({ inProgress: watching, type, toPath: to?.url.pathname ?? null });
    if (action === 'native') cancel();
    else if (action === 'confirm' && !confirm('Leave your Watch? Your votes so far are kept.')) cancel();
  });
  let hearts = $derived(heartsLeft(shown.status));
  // Which body the page shows: the template branches on it, and the ruling sits directly above the stage when there is one.
  let screen = $derived.by(() => {
    if (shown.mode === 'apprentice') {
      const apprentice = shown.apprentice;
      if (apprentice.kind === 'question') return { kind: 'apprentice-question' as const, apprentice };
      if (apprentice.kind === 'checkpoint') return { kind: 'checkpoint' as const, apprentice };
      return { kind: 'no-practice' as const };
    }
    if (shown.muted) return { kind: 'muted' as const };
    if (shown.lockoutSeconds) return { kind: 'lockout' as const, seconds: shown.lockoutSeconds };
    if (view) return { kind: 'queue-stage' as const, view };
    return { kind: shown.resetPending ? ('none' as const) : ('clear' as const), daily: shown.daily };
  });
  let rulingInStage = $derived(screen.kind === 'apprentice-question' || screen.kind === 'queue-stage');
  let formMessage = $derived(
    form?.message && !form.resetNoticeFailed && !form.noticeFailed && !form.guideFailed && !form.progressFailed
      ? form.message
      : null
  );
</script>

<svelte:head>
  <title>Judge · Knights of New Order</title>
</svelte:head>

<svelte:window
  {onkeydown}
  onbeforeunload={(event) => {
    // Votes still queued would be dropped silently.
    if (tracker.pending > 0) event.preventDefault();
  }}
/>

{#snippet pill(option: { value: string; label: string }, index: number, locked: boolean, asksReason: boolean)}
  <AnswerPill
    {option}
    {index}
    picked={picked === option.value}
    hint={levelHint.get(option.value)}
    yesNo={yesNo}
    disabled={submitting || locked}
    onclick={asksReason && option.value === BLOCKED_ANSWER
      ? (event) => {
          event.preventDefault();
          reasonItem = view?.item.key ?? null;
        }
      : undefined}
  />
{/snippet}

{#snippet soundToggle()}
  <button
    type="button"
    class="quiet sound"
    aria-label={soundMuted ? 'Sound off' : 'Sound on'}
    title={soundMuted ? 'Sound off, turn on' : 'Sound on, mute'}
    aria-pressed={!soundMuted}
    onclick={toggleSound}
  >
    <Icon name={soundMuted ? 'volume-x' : 'volume-2'} size={16} />
  </button>
{/snippet}

{#snippet questionTools()}
  <div class="qtools">
    <button type="button" class="quiet guide" onclick={() => openGuide(guide)}>
      <Icon name="book-open" size={16} />Guide
    </button>
    {@render soundToggle()}
  </div>
{/snippet}

{#snippet ruling(anchored: boolean)}
  <!-- Not drawn under a dialog, so its auto-hide never runs unseen. -->
  {#if rulingNotice.showing && !dialogOpen}
    <RulingToast
      notices={shown.notices}
      message={form?.noticeFailed && rulingNotice.failed ? form.message : null}
      submit={rulingNotice.submit}
      {anchored}
    />
  {/if}
{/snippet}

{#snippet levelToast(floating: boolean)}
  {#if levelNotice && progress.showing}
    <LevelToast
      level={levelNotice.milestoneLevel ?? levelNotice.level}
      xpToNext={(levelNotice.milestoneLevel ?? levelNotice.level) === shown.status.level ? shown.status.xpForNextLevel - shown.status.xpIntoLevel : null}
      message={form?.progressFailed && progress.failed ? form.message : null}
      submit={progress.submit}
      {floating}
      milestone={levelNotice.milestone ?? null}
      gold={levelNotice.levelGold ?? 0}
    />
  {/if}
{/snippet}

<div class="play">
  {#if careerReset.showing}
    <ResetNotice
      smites={shown.status.maxSmites}
      message={form?.resetNoticeFailed && careerReset.failed ? form.message : null}
      submit={careerReset.submit}
    />
  {:else}
  {#if shown.mode === 'queue' && shown.apprenticeMeter}
    <ApprenticeMeter
      level={shown.status.level}
      levelFraction={shown.status.progressPercent / 100}
      accuracy={shown.apprenticeMeter.accuracy}
      bar={shown.apprenticeMeter.bar}
      knightLevel={shown.apprenticeMeter.knightLevel}
      answerWindow={shown.apprenticeMeter.window}
    />
  {:else if strip && shown.mode === 'queue'}
    <WatchMeta
      value={strip.value}
      max={strip.max}
      watch={shown.daily.watch}
      done={strip.done}
      streak={withVotesSent(shown.daily, pendingVotes(inFlight, shown.daily)).streak}
      {hearts}
      maxHearts={shown.status.maxSmites}
      heartBack={shown.status.heartBack}
      onmore={() => (railSheetOpen = true)}
    />
  {:else if shown.mode === 'apprentice'}
    <ApprenticeMeter
      level={shown.status.level}
      levelFraction={shown.status.progressPercent / 100}
      accuracy={shown.apprentice.progress.accuracy}
      bar={shown.apprentice.progress.bar}
      knightLevel={shown.apprentice.progress.knightLevel}
      answerWindow={shown.apprentice.progress.window}
      {hearts}
      maxHearts={shown.status.maxSmites}
    />
  {/if}

  <div class="body">
  <div class="main">
  {#if !rulingInStage}{@render ruling(false)}{/if}

  {#if shown.mode === 'queue' && shown.resetPending}
    <p class="notice flat" role="alert">Your career is being reset. Return in a moment.</p>
  {/if}

  {#if screen.kind === 'apprentice-question'}
    {@const apprentice = screen.apprentice}
    <div class="column">
      <div class="qrow">
        <p class="question" title={apprentice.prompt}>
          <span class="eyebrow">Question</span>
          <span class="text">{apprentice.prompt}</span>
        </p>
        {@render questionTools()}
      </div>
      <div class="stagewrap">
        {#key `${apprentice.item.kind}:${apprentice.item.referenceId}`}
          <ImageStage
            src={apprentice.item.src}
            width={apprentice.item.width}
            height={apprentice.item.height}
            alt="The subject of this question"
          />
        {/key}
        {@render levelToast(true)}
        {@render ruling(true)}
      </div>
      <div class="controls" class:yesno={yesNo}>
        <form class="answers answer-row" method="POST" action="?/apprentice" use:enhance={submitApprentice} bind:this={answers}>
          <input type="hidden" name="kind" value={apprentice.item.kind} />
          <input type="hidden" name="referenceId" value={apprentice.item.referenceId} />
          <input type="hidden" name="version" value={apprentice.item.version ?? ''} />
          {#if levelNotice}<input type="hidden" name="noticeShown" value="1" />{/if}
          {#each apprentice.options as option, index (option.value)}
            {@render pill(option, index, false, false)}
          {/each}
        </form>
        {#if !yesNo}
          <span class="rowtool"><button type="button" class="quiet guide" onclick={() => openGuide(guide)}>Rating guide</button></span>
        {/if}
        <span class="rowtool">{@render soundToggle()}</span>
      </div>
      {#if formMessage}
        <p class="notice flat" role="alert">{formMessage}</p>
      {/if}
    </div>
  {:else if screen.kind === 'checkpoint'}
    {@render levelToast(false)}
    <CheckpointRecap
      recap={screen.apprentice}
      noticeShown={!!levelNotice}
      message={formMessage}
      {submitting}
      submit={submitCheckpoint}
      onguide={() => openGuide(guide)}
    />
  {:else if screen.kind === 'no-practice'}
    <div class="panel">
      {@render levelToast(false)}
      <section class="lockout" role="status" aria-label="No more practice items">
        <h2>No more practice items right now</h2>
        <p>Check back soon. New ones are added from time to time, and your progress is kept.</p>
      </section>
    </div>
  {:else if screen.kind === 'muted'}
    <div class="panel">
      <section class="lockout" role="status" aria-label="Judging unavailable">
        <h2>Judging is closed to you</h2>
        <p>Your account is muted, so you can't judge right now. You can still view your record and your gold.</p>
      </section>
    </div>
  {:else if screen.kind === 'lockout'}
    <div class="panel">
      {@render levelToast(false)}
      <section class="lockout" role="status" aria-label="Judging paused">
        <h2>A moment of rest</h2>
        <p>You have been judging faster than the Order can trust. Rest a little; the queue will wait.</p>
        <Countdown seconds={screen.seconds} label="Time until judging resumes" />
        <p class="muted">Judging resumes by itself.</p>
      </section>
    </div>
  {:else if screen.kind === 'queue-stage'}
    {@const shown = screen.view}
    <div class="column">
      <div class="qrow">
      <p class="question" title={shown.question.prompt}>
        <span class="eyebrow">
          Question
          {#if shown.category}
            <!-- Re-keyed (and glows once) only when the category changes; the text is part of the question for screen readers. -->
            {#key shown.category.heading}
              <span class="category" class:glow={shown.banner !== null}>
                <span aria-hidden="true">·</span><span class="vh">Category: </span>{shown.category.heading}
              </span>
            {/key}
          {/if}
        </span>
        <span class="text">{shown.question.prompt}</span>
      </p>
      {@render questionTools()}
      </div>
      <span class="vh" role="status" aria-live="polite"
        >{shown.banner ? `New questions: ${shown.banner.heading}` : ''}</span
      >
      <div class="stagewrap">
        {#key shown.item.key}
          {@const itemKey = shown.item.key}
          <ImageStage
            src={shown.item.src}
            width={shown.item.width}
            height={shown.item.height}
            alt="The subject of this judgment"
            failed={imageFailed}
            onfail={() => (failedItem = itemKey)}
          />
        {/key}
        {@render levelToast(true)}
        {@render ruling(true)}
        {#if settledOnScreen}
          <SettledCard ready={settledReady} oncontinue={continueFromSettled} />
        {:else if note}
          <p class="nudge" class:sticky>
            <span role="status">{note}</span>
            {#if sticky}
              <button type="button" class="nudge-close" aria-label="Dismiss" onclick={unstick}>×</button>
            {/if}
          </p>
        {:else if cue}
          <p class="nudge cheer" role="status">{cue}</p>
        {/if}
      </div>
      <div class="controls" class:yesno={yesNo} class:failed={imageFailed}>
        <form class="answers answer-row" method="POST" action="?/vote" use:enhance={submitJudgment} bind:this={answers}>
          <input type="hidden" name="item" value={shown.item.id} />
          {#each shown.question.options as option, index (option.value)}
            {@render pill(option, index, imageFailed || settledOnScreen, asksBlockReason(shown.question.key))}
          {/each}
        </form>
        <form class="skip" method="POST" action="?/skip" use:enhance={submitJudgment} bind:this={skipForm}>
          <input type="hidden" name="item" value={shown.item.id} />
          <button type="submit" class="quiet" disabled={submitting || settledOnScreen} aria-label="Skip" title="Skip (Space)">
            <Icon name="skip-forward" size={14} /><span class="skiplabel">Skip</span><span class="space">&nbsp;·&nbsp;Space</span>
          </button>
        </form>
        <span class="rowtool">
          <button type="button" class="quiet guide" onclick={() => openGuide(guide)}>Rating guide</button>
        </span>
        <span class="rowtool">{@render soundToggle()}</span>
        {#if choosingReason}
          <BlockReasons onpick={pickReason} oncancel={() => (reasonItem = null)} />
        {/if}
      </div>
      {#if formMessage}
        <p class="notice flat" role="alert">{formMessage}</p>
      {/if}
    </div>
  {:else if screen.kind === 'clear'}
    {@render levelToast(false)}
    <QueueClear daily={screen.daily} />
  {/if}
  </div>
  {#if shown.mode === 'queue' && !shown.apprenticeMeter}
    <PlayRail status={shown.status} daily={withVotesSent(shown.daily, pendingVotes(inFlight, shown.daily), pendingGoldVotes(inFlight, shown.daily))} rail={shown.rail} ladder={shown.ladder} />
  {/if}
  </div>
  {/if}
</div>

{#if railSheetOpen && shown.mode === 'queue' && !shown.apprenticeMeter}
  <RailSheet
    status={shown.status}
    daily={withVotesSent(shown.daily, pendingVotes(inFlight, shown.daily), pendingGoldVotes(inFlight, shown.daily))}
    rail={shown.rail}
    ladder={shown.ladder}
    onclose={() => (railSheetOpen = false)}
  />
{/if}

{#if guideOpen}
  <GuideDialog
    guide={shown.ratingGuide}
    scrollToRules={yesNo}
    first={shown.showGuide}
    message={form?.guideFailed ? form.message : null}
    {submitting}
    submit={submitGuide}
  />
{:else if shown.progress?.kind === 'rank' && progress.showing}
  <RankUpDialog
    rank={shown.progress.rank}
    level={shown.progress.level}
    levels={shown.progress.levels}
    goldMultiplier={shown.progress.goldMultiplier}
    previous={shown.progress.previous}
    badge={shown.badges.large[shown.progress.rank]}
    message={form?.progressFailed && progress.failed ? form.message : null}
    submit={progress.submit}
  />
{/if}

<style>
  .play {
    position: relative;
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
  }
  /* The image column, and from 1200px the single right rail beside it. */
  .body {
    display: flex;
    flex: 1 1 0;
    min-height: 0;
  }
  .main {
    display: flex;
    flex: 1 1 0;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
  }

  /* The stage and whatever floats over it (the level-up toast). */
  .stagewrap {
    position: relative;
    display: grid;
    grid-template: minmax(0, 1fr) / minmax(0, 1fr);
    flex: 1 1 0;
    min-height: 0;
  }

  /* A refused or lost vote, over the stage so it never moves the pills. */
  .nudge {
    position: absolute;
    bottom: 12px;
    left: 50%;
    z-index: 4;
    max-width: calc(100% - 2rem);
    margin: 0;
    padding: 8px 14px;
    transform: translateX(-50%);
    border: 1px solid var(--io-crimson);
    border-radius: 8px;
    background: #14110dee;
    color: var(--io-parchment);
    font: 400 13px/1.3 var(--io-font-ui);
    text-align: center;
  }
  .nudge.sticky {
    display: flex;
    align-items: center;
    gap: 10px;
    text-align: left;
  }
  .nudge-close {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    min-height: 28px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--io-parchment);
    font-size: 16px;
    line-height: 1;
  }
  .nudge.cheer {
    border-color: var(--io-gold);
  }

  .column {
    display: flex;
    flex: 1 1 0;
    flex-direction: column;
    gap: 16px;
    width: 100%;
    max-width: 1056px;
    min-height: 12rem;
    margin: 0 auto;
    padding: 8px 28px 20px;
  }
  .panel {
    width: 100%;
    max-width: 48rem;
    margin: 0 auto;
    padding: 1rem 1.5rem 2rem;
  }
  .flat {
    margin: 0;
    flex: none;
  }
  .lockout {
    padding: 1rem 1.5rem;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--panel);
    text-align: center;
  }

  /* Phones carry the guide and sound toggle beside the question, so the answers keep one row. */
  .qrow {
    display: flex;
    flex: none;
    align-items: flex-start;
    gap: 12px;
  }
  .qrow .question {
    flex: 1 1 0;
  }
  .qtools {
    display: none;
  }
  .rowtool {
    display: contents;
  }

  /* The eyebrow (and category) sits on its own line so the question keeps the full width. */
  .question {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    margin: 0;
  }
  .eyebrow {
    display: flex;
    flex-wrap: wrap;
    gap: 0 8px;
    color: var(--io-gold);
    font: 600 11px/1.4 var(--io-font-ui);
    letter-spacing: 2px;
    text-transform: uppercase;
  }
  .category {
    display: inline-flex;
    gap: 8px;
    color: var(--io-parchment-muted);
  }
  .text {
    min-width: 0;
    overflow: hidden;
    color: var(--io-parchment);
    font: 700 16px/1.25 var(--io-font-display);
    /* Wraps in full: phones can't hover for the title. */
  }
  .category.glow {
    animation: category-glow 1.8s ease-out 1;
  }
  @keyframes category-glow {
    0% {
      color: var(--io-gold);
      text-shadow: 0 0 0 transparent;
    }
    40% {
      color: var(--io-gold);
      text-shadow: 0 0 10px color-mix(in srgb, var(--io-gold) 70%, transparent);
    }
    100% {
      text-shadow: 0 0 0 transparent;
    }
  }
  .vh {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .controls {
    position: relative;
    display: flex;
    flex: none;
    align-items: center;
    gap: 16px;
  }
  .controls.yesno .answers {
    gap: 12px;
  }
  .skip {
    display: contents;
  }
  .quiet {
    min-height: 0;
    padding: 4px 0;
    border: 0;
    background: none;
    color: var(--io-parchment-muted);
    font: 400 12px/1.2 var(--io-font-ui);
    white-space: nowrap;
  }
  .quiet:hover:not(:disabled) {
    background: none;
    color: var(--io-parchment);
  }
  .skip .quiet {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .quiet.guide {
    color: var(--io-gold);
  }
  .quiet.guide:hover:not(:disabled) {
    color: var(--io-parchment);
  }
  .quiet.sound {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .quiet.sound :global(svg) {
    color: var(--io-gold);
  }

  kbd {
    font-family: inherit;
  }
  /* The image failed: Skip is the one way forward, so it stops being quiet. */
  .controls.failed .quiet:not(.guide) {
    color: var(--io-gold);
    font-weight: 700;
  }
  .controls.failed :global(.pill) {
    opacity: 0.4;
  }

  @media (max-width: 40rem) {
    .column {
      gap: 8px;
      min-height: 10rem;
      padding: 4px 16px max(8px, env(safe-area-inset-bottom));
    }
    .eyebrow {
      font-size: 12px;
      letter-spacing: 1.2px;
    }
    .text {
      font-size: 14px;
    }
    /* Pinned beside the eyebrow line only, so the question text keeps the full width below it. */
    .qrow {
      position: relative;
    }
    .qtools {
      position: absolute;
      top: -10px;
      right: 0;
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .qrow .eyebrow {
      padding-right: 8rem;
    }
    .qtools .quiet {
      gap: 6px;
      min-width: 0;
      min-height: 36px;
      font-size: 13px;
    }
    .qtools .quiet.sound {
      justify-content: center;
      min-width: 36px;
    }
    .controls .rowtool {
      display: none;
    }
    .controls {
      gap: 6px;
    }
    .skip {
      display: block;
      flex: none;
    }
    .quiet {
      display: flex;
      align-items: center;
    }
    /* Skip ends the answer row as a quiet bordered button: an icon beside the ratings, labelled beside yes/no. */
    .skip .quiet {
      justify-content: center;
      min-width: 44px;
      min-height: 0;
      height: 40px;
      padding: 0 6px;
      border: 1px solid var(--border);
      border-radius: 6px;
    }
    .skiplabel {
      display: none;
    }
    .controls.yesno .skiplabel {
      display: inline;
    }
    .space {
      display: none;
    }
    .panel {
      padding: 0.5rem 1rem 1.5rem;
    }
  }
</style>
