<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { applyAction, deserialize, enhance } from '$app/forms';
  import { beforeNavigate, invalidate } from '$app/navigation';
  import type { SubmitFunction } from '@sveltejs/kit';
  import BlockReasons from './BlockReasons.svelte';
  import ApprenticeMeter from './ApprenticeMeter.svelte';
  import CheckpointRecap from './CheckpointRecap.svelte';
  import GuideDialog from './GuideDialog.svelte';
  import ImageStage from './ImageStage.svelte';
  import LevelToast from './LevelToast.svelte';
  import QueueClear from './QueueClear.svelte';
  import RankUpDialog from './RankUpDialog.svelte';
  import ResetNotice from './ResetNotice.svelte';
  import Countdown from '$lib/Countdown.svelte';
  import Icon from '$lib/Icon.svelte';
  import { sound } from '$lib/sound';
  import WatchHairline from '$lib/WatchHairline.svelte';
  import WatchMeta from '$lib/WatchMeta.svelte';
  import { heartsLeft, watchStrip, withVotesSent } from '$lib/chrome';
  import { leaveAction, watchInProgress } from '$lib/leave-guard';
  import PlayRail from './PlayRail.svelte';
  import { answerForKey, answerForKeyPress, optionsOnScreen } from './keys';
  import { whatsNewView } from '$lib/whats-new-dismiss.svelte';
  import {
    MAX_EXCLUDED,
    createItemBuffer,
    createSerialQueue,
    createVoteTracker,
    postVote,
    refillCount,
    type PickedItem,
  } from './optimistic';
  import { BLOCKED_ANSWER, BLOCK_REASONS, asksBlockReason, type BlockReason } from '$lib/block-reasons';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
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
  let guideReopened = $state(false);
  let guideOpen = $derived(data.showGuide || guideReopened);
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
  let blockReason = $state<BlockReason | null>(null);
  // A dialog is up: it owns the keyboard, so the answer keys and Space do nothing behind it.
  const whatsNew = whatsNewView();
  let dialogOpen = $derived(whatsNew.showing || guideOpen || data.progress?.kind === 'rank');
  let levelNotice = $derived(!guideOpen && data.progress?.kind === 'level' ? data.progress : null);

  // Header-menu dialogs (feedback, restart career) don't set `dialogOpen`; the reason picker is this page's own.
  const headerDialogOpen = () =>
    !!document.querySelector(
      '[role="dialog"][aria-modal="true"]:not([aria-labelledby="block-reason-title"])'
    );

  // The number keys answer in option order (a yes/no question also takes Y and N), in the queue and the apprenticeship alike,
  // and Space skips a queue item, even while an answer button has focus (the browser would otherwise press it). Typing in a
  // field or holding a modifier is left alone.
  function onkeydown(event: KeyboardEvent) {
    if (headerDialogOpen()) return;
    if (choosingReason) {
      const reason = answerForKey([...BLOCK_REASONS], event.key);
      if (reason && !event.ctrlKey && !event.metaKey && !event.altKey) pickReason(reason as BlockReason);
      return;
    }
    const options = optionsOnScreen({
      question: view?.question,
      apprentice: data.mode === 'apprentice' ? data.apprentice : null,
    });
    if (event.repeat || dialogOpen || !options || submitting) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable], header')) return;
    if (event.key === ' ') {
      event.preventDefault();
      if (view) skipForm?.requestSubmit();
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

  const submitGuide: SubmitFunction = () => {
    submitting = true;
    return async ({ result, update }) => {
      try {
        await update();
        if (result.type === 'success') guideReopened = false;
      } finally {
        submitting = false;
      }
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

  function tell(message: string) {
    note = message;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => (note = null), NOTE_MS);
  }

  // Background votes go one at a time, in the order they were answered: this page posts one vote at a time.
  const votes = createSerialQueue();
  const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

  function post(action: URL, body: FormData, key: string, counted: boolean) {
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
        if (counted) sentVotes = Math.max(0, sentVotes - 1);
        counted = false;
        tell(outcome.message);
        dropBuffered(key);
        if (outcome.resync) {
          local = null;
          clearBuffer();
          refilling = false;
        }
      },
      // The page's own data (status, rewards, level notices) is read again once the vote has landed.
      onSettled: async () => {
        await invalidate('app:play').catch(() => {});
        // The page's data now holds the vote, so it stops being counted on top.
        if (counted) sentVotes = Math.max(0, sentVotes - 1);
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
    if (isVote) sentVotes += 1;
    void post(input.action, input.formData, key, isVote);
  };

  // Votes posted in the background that the page's data does not hold yet; the Watch counts them at once.
  let sentVotes = $state(0);
  let strip = $derived(data.mode === 'queue' ? watchStrip(withVotesSent(data.daily, sentVotes)) : null);
  let watching = $derived(data.mode === 'queue' && !paused && Boolean(view) && watchInProgress(data.daily));

  beforeNavigate(({ cancel, type, to }) => {
    const action = leaveAction({ inProgress: watching, type, toPath: to?.url.pathname ?? null });
    if (action === 'native') cancel();
    else if (action === 'confirm' && !confirm('Leave your Watch? Your votes so far are kept.')) cancel();
  });
  let hearts = $derived(heartsLeft(data.status));
  let formMessage = $derived(
    form?.message && !form.resetNoticeFailed && !form.noticeFailed && !form.guideFailed && !form.progressFailed && !form.whatsNewFailed
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
  {@const blocked = option.label.toLowerCase() === 'blocked'}
  {@const yesNoIcon = yesNo ? (option.value === 'yes' ? 'check' : 'x') : null}
  <button
    type="submit"
    class="pill"
    class:blocked
    class:picked={picked === option.value}
    name="answer"
    value={option.value}
    title={levelHint.get(option.value)}
    aria-label={blocked ? 'Blocked' : undefined}
    disabled={submitting || locked}
    onclick={asksReason && option.value === BLOCKED_ANSWER
      ? (event) => {
          event.preventDefault();
          reasonItem = view?.item.key ?? null;
        }
      : undefined}
  >
    {#if yesNoIcon}<Icon name={yesNoIcon} />{/if}
    {#if blocked}<span class="ban"><Icon name="ban" size={20} /></span>{/if}
    <span class="level">{option.label}</span>
    <kbd class="key" aria-hidden="true">{index + 1}</kbd>
  </button>
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

{#snippet levelToast(floating: boolean)}
  {#if levelNotice}
    <LevelToast
      level={levelNotice.milestoneLevel ?? levelNotice.level}
      xpToNext={(levelNotice.milestoneLevel ?? levelNotice.level) === data.status.level ? data.status.xpForNextLevel - data.status.xpIntoLevel : null}
      message={form?.progressFailed ? form.message : null}
      {submitting}
      {submit}
      {floating}
      milestone={levelNotice.milestone ?? null}
      gold={levelNotice.levelGold ?? 0}
    />
  {/if}
{/snippet}

<div class="play">
  {#if data.resetNotice}
    <ResetNotice
      smites={data.status.maxSmites}
      message={form?.resetNoticeFailed ? form.message : null}
      {submitting}
      {submit}
    />
  {:else}
  {#if data.mode === 'queue' && data.apprenticeMeter}
    <ApprenticeMeter
      level={data.status.level}
      levelFraction={data.status.progressPercent / 100}
      accuracy={data.apprenticeMeter.accuracy}
      bar={data.apprenticeMeter.bar}
      knightLevel={data.apprenticeMeter.knightLevel}
      answerWindow={data.apprenticeMeter.window}
    />
  {:else if strip && data.mode === 'queue'}
    <WatchHairline label={strip.label} value={strip.value} max={strip.max} />
    <WatchMeta
      value={strip.value}
      max={strip.max}
      streak={withVotesSent(data.daily, sentVotes).streak}
      {hearts}
      maxHearts={data.status.maxSmites}
    />
  {:else if data.mode === 'apprentice'}
    <ApprenticeMeter
      level={data.status.level}
      levelFraction={data.status.progressPercent / 100}
      accuracy={data.apprentice.progress.accuracy}
      bar={data.apprentice.progress.bar}
      knightLevel={data.apprentice.progress.knightLevel}
      answerWindow={data.apprentice.progress.window}
    />
  {/if}

  <div class="body">
  <div class="main">
  {#if data.notices.length > 0}
    <section class="toast" role="status" aria-label="Skill check">
      <Icon name="triangle-alert" size={18} />
      <div class="toast-body">
        {#each data.notices as notice (notice.title)}
          <p><strong>{notice.title}</strong> {notice.message}</p>
        {/each}
        {#if form?.noticeFailed}
          <p>{form.message}</p>
        {/if}
      </div>
      <form method="POST" action="?/dismissNotices" use:enhance={submit}>
        <button type="submit" disabled={submitting}>Understood</button>
      </form>
    </section>
  {/if}

  {#if data.mode === 'queue' && data.resetPending}
    <p class="notice flat" role="alert">Your career is being reset. Return in a moment.</p>
  {/if}

  {#if data.mode === 'apprentice'}
    {#if data.apprentice.kind === 'question'}
      <div class="column">
        <p class="question" title={data.apprentice.prompt}>
          <span class="eyebrow">Question ·</span>
          <span class="text">{data.apprentice.prompt}</span>
        </p>
        <div class="stagewrap">
          {#key `${data.apprentice.item.kind}:${data.apprentice.item.referenceId}`}
            <ImageStage
              src={data.apprentice.item.src}
              width={data.apprentice.item.width}
              height={data.apprentice.item.height}
              alt="The subject of this question"
            />
          {/key}
          {@render levelToast(true)}
        </div>
        <div class="controls" class:yesno={yesNo}>
          <form class="answers" method="POST" action="?/apprentice" use:enhance={submitApprentice} bind:this={answers}>
            <input type="hidden" name="kind" value={data.apprentice.item.kind} />
            <input type="hidden" name="referenceId" value={data.apprentice.item.referenceId} />
            <input type="hidden" name="version" value={data.apprentice.item.version ?? ''} />
            {#if levelNotice}<input type="hidden" name="noticeShown" value="1" />{/if}
            {#each data.apprentice.options as option, index (option.value)}
              {@render pill(option, index, false, false)}
            {/each}
          </form>
          {#if !yesNo}
            <button type="button" class="quiet guide" onclick={() => (guideReopened = true)}>Rating guide</button>
          {/if}
          {@render soundToggle()}
        </div>
        {#if formMessage}
          <p class="notice flat" role="alert">{formMessage}</p>
        {/if}
      </div>
    {:else if data.apprentice.kind === 'checkpoint'}
      {@render levelToast(false)}
      <CheckpointRecap
        recap={data.apprentice}
        noticeShown={!!levelNotice}
        message={formMessage}
        {submitting}
        submit={submitCheckpoint}
        onguide={() => (guideReopened = true)}
      />
    {:else}
      <div class="panel">
        {@render levelToast(false)}
        <section class="lockout" role="status" aria-label="No more practice items">
          <h2>No more practice items right now</h2>
          <p>Check back soon. New ones are added from time to time, and your progress is kept.</p>
        </section>
      </div>
    {/if}
  {:else if data.mode === 'queue' && data.muted}
    <div class="panel">
      <section class="lockout" role="status" aria-label="Judging unavailable">
        <h2>Judging is closed to you</h2>
        <p>Your account is muted, so you can't judge right now. You can still view your record and your gold.</p>
      </section>
    </div>
  {:else if data.mode === 'queue' && data.lockoutSeconds}
    <div class="panel">
      {@render levelToast(false)}
      <section class="lockout" role="status" aria-label="Judging paused">
        <h2>A moment of rest</h2>
        <p>You have been judging faster than the Order can trust. Rest a little; the queue will wait.</p>
        <Countdown seconds={data.lockoutSeconds} label="Time until judging resumes" />
        <p class="muted">Judging resumes by itself.</p>
      </section>
    </div>
  {:else if view}
    <div class="column">
      <p class="question" title={view.question.prompt}>
        <span class="eyebrow">Question ·</span>
        {#if view.category}
          <!-- A new chip (and its one-time glow) only when the category changes; the text is part of the question for screen readers. -->
          {#key view.category.heading}
            <span class="chip" class:glow={view.banner !== null}>
              <span class="vh">Category: </span>{view.category.heading}
            </span>
          {/key}
        {/if}
        <span class="text">{view.question.prompt}</span>
      </p>
      <span class="vh" role="status" aria-live="polite"
        >{view.banner ? `New questions: ${view.banner.heading}` : ''}</span
      >
      <div class="stagewrap">
        {#key view.item.key}
          {@const itemKey = view.item.key}
          <ImageStage
            src={view.item.src}
            width={view.item.width}
            height={view.item.height}
            alt="The subject of this judgment"
            failed={imageFailed}
            onfail={() => (failedItem = itemKey)}
          />
        {/key}
        {@render levelToast(true)}
        {#if note}
          <p class="nudge" role="status">{note}</p>
        {/if}
      </div>
      <div class="controls" class:yesno={yesNo} class:failed={imageFailed}>
        <form class="answers" method="POST" action="?/vote" use:enhance={submitJudgment} bind:this={answers}>
          <input type="hidden" name="item" value={view.item.id} />
          {#each view.question.options as option, index (option.value)}
            {@render pill(option, index, imageFailed, asksBlockReason(view.question.key))}
          {/each}
        </form>
        <form class="skip" method="POST" action="?/skip" use:enhance={submitJudgment} bind:this={skipForm}>
          <input type="hidden" name="item" value={view.item.id} />
          <button type="submit" class="quiet" disabled={submitting}>
            <Icon name="skip-forward" size={14} />Skip<span class="space">&nbsp;·&nbsp;Space</span>
          </button>
        </form>
        {#if !yesNo}
          <button type="button" class="quiet guide" onclick={() => (guideReopened = true)}>Rating guide</button>
        {/if}
        {@render soundToggle()}
        {#if choosingReason}
          <BlockReasons onpick={pickReason} oncancel={() => (reasonItem = null)} />
        {/if}
      </div>
      {#if formMessage}
        <p class="notice flat" role="alert">{formMessage}</p>
      {/if}
    </div>
  {:else if !data.resetPending}
    {@render levelToast(false)}
    <QueueClear daily={data.daily} />
  {/if}
  </div>
  {#if data.mode === 'queue' && !data.apprenticeMeter}
    <PlayRail status={data.status} daily={withVotesSent(data.daily, sentVotes)} rail={data.rail} ladder={data.ladder} />
  {/if}
  </div>
  {/if}
</div>

{#if guideOpen}
  <GuideDialog
    guide={data.ratingGuide}
    first={data.showGuide}
    message={form?.guideFailed ? form.message : null}
    {submitting}
    submit={submitGuide}
  />
{:else if data.progress?.kind === 'rank'}
  <RankUpDialog
    rank={data.progress.rank}
    level={data.progress.level}
    levels={data.progress.levels}
    goldMultiplier={data.progress.goldMultiplier}
    dailyGoldCap={data.progress.dailyGoldCap}
    previous={data.progress.previous}
    badge={data.badges.large[data.progress.rank]}
    message={form?.progressFailed ? form.message : null}
    {submitting}
    {submit}
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

  /* The hidden-check warning floats over the stage, so it never moves the stage or the pills. */
  .toast {
    position: absolute;
    top: 4.5rem;
    left: 50%;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 12px;
    width: min(34rem, calc(100% - 2rem));
    padding: 12px 16px;
    transform: translateX(-50%);
    border: 1px solid var(--io-crimson);
    border-radius: 12px;
    background: #14110dee;
    color: var(--io-crimson-text);
    font: 400 13px/1.4 var(--io-font-ui);
  }
  .toast-body {
    flex: 1;
  }
  .toast-body p {
    margin: 0;
    color: var(--io-parchment);
  }
  .toast-body strong {
    display: block;
    color: var(--io-crimson-text);
  }
  .toast button {
    min-height: 0;
    padding: 6px 12px;
    border-color: var(--io-crimson);
    font-size: 12px;
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

  .question {
    display: flex;
    flex: none;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
    margin: 0;
  }
  .eyebrow {
    flex: none;
    color: var(--io-gold);
    font: 600 11px/1 var(--io-font-ui);
    letter-spacing: 2px;
    text-transform: uppercase;
  }
  .text {
    min-width: 0;
    overflow: hidden;
    color: var(--io-parchment);
    font: 700 16px/1.25 var(--io-font-display);
    /* Wraps in full: phones can't hover for the title. */
  }
  .chip {
    flex: none;
    padding: 3px 8px;
    border: 1px solid color-mix(in srgb, var(--io-gold) 45%, transparent);
    border-radius: 999px;
    color: var(--io-gold);
    font: 600 11px/1 var(--io-font-ui);
    letter-spacing: 2px;
    text-transform: uppercase;
  }
  .chip.glow {
    animation: chip-glow 1.8s ease-out 1;
  }
  @keyframes chip-glow {
    0% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--io-gold) 70%, transparent);
    }
    40% {
      box-shadow: 0 0 12px 3px color-mix(in srgb, var(--io-gold) 55%, transparent);
    }
    100% {
      box-shadow: 0 0 0 0 transparent;
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
  .answers {
    display: flex;
    flex: 1 1 auto;
    gap: 8px;
    min-width: 0;
  }
  .controls.yesno .answers {
    gap: 12px;
  }
  .pill {
    display: flex;
    flex: 1 1 0;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-width: 0;
    height: 40px;
    padding: 0 10px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 6px;
    background: var(--io-bg);
    color: var(--io-parchment);
    font: 700 14px/1 var(--io-font-ui);
    transition:
      border-color var(--motion-fast) var(--ease-out-quart),
      background-color var(--motion-fast) var(--ease-out-quart),
      color var(--motion-fast) var(--ease-out-quart),
      box-shadow var(--motion-fast) var(--ease-out-quart),
      transform var(--motion-base) var(--ease-out-quart);
  }
  /* The design's M1: the answer presses in (0.97) and holds a gold ring until the next image replaces it. The answer is
     already submitted at the press; nothing here waits for the release. */
  .pill:active:not(:disabled),
  .pill.picked,
  .pill.picked:disabled {
    transform: scale(0.97);
    box-shadow:
      0 0 0 2px var(--io-gold),
      0 0 14px rgb(201 162 74 / 0.4);
    transition-duration: var(--motion-fast);
  }
  .pill.blocked.picked,
  .pill.blocked:active:not(:disabled) {
    box-shadow:
      0 0 0 2px var(--io-crimson-text),
      0 0 14px rgb(224 138 130 / 0.35);
  }
  @media (prefers-reduced-motion: reduce) {
    .chip.glow {
      animation: none;
    }
    .pill,
    .pill:active:not(:disabled),
    .pill.picked,
    .pill.picked:disabled {
      transform: none;
      transition-duration: 120ms;
    }
  }
  .controls.yesno .pill {
    padding: 0 16px;
  }
  .pill:hover:not(:disabled) {
    border-color: var(--io-gold);
    background: var(--io-bg);
  }
  .pill.picked,
  .pill.picked:disabled {
    border-color: var(--io-gold);
    background: var(--io-surface);
    color: var(--io-gold);
    opacity: 1;
  }
  .pill.blocked {
    border-color: var(--io-crimson);
    color: var(--io-crimson-text);
  }
  .pill.blocked:hover:not(:disabled) {
    border-color: var(--io-crimson-text);
  }
  .pill.blocked.picked {
    border-color: var(--io-crimson-text);
    color: var(--io-crimson-text);
  }
  .pill :global(svg) {
    flex: none;
  }
  .key {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 6px;
    background: var(--io-bg);
    color: var(--io-parchment-muted);
    font: 700 12px/1 var(--io-font-ui);
    order: -1;
  }
  .controls.yesno .key {
    order: 1;
    width: auto;
    background: none;
  }
  .picked .key {
    background: var(--io-bg);
    color: var(--io-parchment-muted);
  }
  .ban {
    display: none;
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
  .controls.failed .pill {
    opacity: 0.4;
  }

  /* Touch and narrow screens: no key chips, 44px targets, the two quiet links on their own row. */
  @media (max-width: 40rem), (hover: none) {
    .key {
      display: none;
    }
  }
  @media (max-width: 40rem) {
    .column {
      gap: 8px;
      min-height: 10rem;
      padding: 4px 16px max(8px, env(safe-area-inset-bottom));
    }
    .toast {
      top: 3.5rem;
    }
    .eyebrow {
      font-size: 12px;
      letter-spacing: 1.2px;
    }
    .text {
      font-size: 14px;
    }
    .controls {
      flex-wrap: wrap;
      gap: 0 16px;
    }
    .answers {
      flex-basis: 100%;
    }
    .pill {
      height: 44px;
      padding: 0 4px;
      font-size: 13px;
    }
    .pill.blocked .level {
      display: none;
    }
    .pill.blocked .ban {
      display: inline-flex;
    }
    .controls.yesno .pill {
      font-size: 14px;
    }
    .skip {
      display: block;
    }
    .quiet {
      display: flex;
      align-items: center;
      min-width: 56px;
      min-height: 44px;
    }
    .quiet.guide,
    .controls.yesno .quiet.sound {
      margin-left: auto;
    }
    .space {
      display: none;
    }
    .panel {
      padding: 0.5rem 1rem 1.5rem;
    }
  }
</style>
