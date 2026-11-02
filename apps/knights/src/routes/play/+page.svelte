<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidate } from '$app/navigation';
  import type { SubmitFunction } from '@sveltejs/kit';
  import GuideDialog from './GuideDialog.svelte';
  import ImageStage from './ImageStage.svelte';
  import LevelToast from './LevelToast.svelte';
  import QueueClear from './QueueClear.svelte';
  import RankUpDialog from './RankUpDialog.svelte';
  import ResetNotice from './ResetNotice.svelte';
  import TrialPips from './TrialPips.svelte';
  import TrialSummary from './TrialSummary.svelte';
  import Countdown from '$lib/Countdown.svelte';
  import Icon from '$lib/Icon.svelte';
  import { sound } from '$lib/sound';
  import WatchProgress from '$lib/WatchProgress.svelte';
  import { heartsLeft, watchStrip } from '$lib/chrome';
  import { recapLines } from './recap-text';
  import { answerForKeyPress } from './keys';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  let submitting = $state(false);
  let answers = $state<HTMLFormElement>();
  let skipForm = $state<HTMLFormElement>();
  let yesNo = $derived(data.mode === 'queue' && data.question?.kind === 'bool');
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
  let imageFailed = $derived(data.mode === 'queue' && !!data.item && failedItem === data.item.id);
  // A dialog is up: it owns the keyboard, so the answer keys and Space do nothing behind it.
  let dialogOpen = $derived(guideOpen || data.progress?.kind === 'rank');
  let levelNotice = $derived(!guideOpen && data.progress?.kind === 'level' ? data.progress : null);

  // The number keys answer in option order (a yes/no question also takes Y and N), and Space skips the item, even while an answer button has focus (the browser would
  // otherwise press it). Typing in a field or holding a modifier is left alone.
  function onkeydown(event: KeyboardEvent) {
    if (dialogOpen || data.mode !== 'queue' || !data.item || submitting) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable], header')) return;
    if (event.key === ' ') {
      event.preventDefault();
      skipForm?.requestSubmit();
      return;
    }
    if (imageFailed || !data.question) return;
    const value = answerForKeyPress(data.question.options, event.key, yesNo);
    if (value) answers?.querySelector<HTMLButtonElement>(`button[value="${value}"]`)?.click();
  }

  // The sound is the Trials' only per-answer cue: called with whether the pick was right, before the next item loads.
  // The page itself shows no verdict mid-run; the summary at the end does.
  function onTrialAnswer(correct: boolean) {
    sound.play(correct ? 'trial-correct' : 'trial-wrong');
  }

  const submitTrial: SubmitFunction = ({ submitter }) => {
    submitting = true;
    picked = answerOf(submitter);
    if (picked) sound.play('press');
    return async ({ result, update }) => {
      try {
        if (result.type === 'success' && typeof result.data?.correct === 'boolean') {
          onTrialAnswer(result.data.correct);
        }
        await update();
        if (result.type === 'failure') await invalidate('app:play');
      } finally {
        submitting = false;
        picked = null;
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

  const submit: SubmitFunction = ({ submitter }) => {
    submitting = true;
    picked = answerOf(submitter);
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

  let strip = $derived(data.mode === 'queue' ? watchStrip(data.daily) : null);
  let hearts = $derived(heartsLeft(data.status));
  let formMessage = $derived(
    form?.message && !form.recapFailed && !form.resetNoticeFailed && !form.noticeFailed && !form.guideFailed && !form.progressFailed
      ? form.message
      : null
  );
</script>

<svelte:window {onkeydown} />

{#snippet pill(option: { value: string; label: string }, index: number, locked: boolean)}
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
  >
    {#if yesNoIcon}<Icon name={yesNoIcon} />{/if}
    {#if blocked}<span class="ban"><Icon name="ban" size={20} /></span>{/if}
    <span class="level">{option.label}</span>
    <kbd class="key" aria-hidden="true">{index + 1}</kbd>
  </button>
{/snippet}

{#snippet levelToast(floating: boolean)}
  {#if levelNotice}
    <LevelToast
      level={levelNotice.level}
      xpToNext={levelNotice.level === data.status.level ? data.status.xpForNextLevel - data.status.xpIntoLevel : null}
      message={form?.progressFailed ? form.message : null}
      {submitting}
      {submit}
      {floating}
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
  {#if strip}
    <WatchProgress
      label={strip.label}
      value={strip.value}
      max={strip.max}
      note={strip.note}
      fervor={data.status.fervor}
      {hearts}
      maxHearts={data.status.maxSmites}
    />
  {:else if data.mode === 'trials' && data.trial.kind === 'question'}
    <TrialPips position={data.trial.run.position} total={data.trial.run.total} passMark={data.trial.passMark} />
  {/if}

  {#if data.notices.length > 0}
    <section class="toast" role="status" aria-label="Sanity check">
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

  {#if data.mode === 'queue' && data.recap}
    <section class="recap" aria-label="Recap of your last play day">
      <div>
        {#each recapLines(data.recap) as line (line)}
          <p>{line}</p>
        {/each}
        {#if form?.recapFailed}
          <p class="notice" role="alert">{form.message}</p>
        {/if}
      </div>
      <form method="POST" action="?/dismissRecap" use:enhance={submit}>
        <button type="submit" disabled={submitting}>Dismiss</button>
      </form>
    </section>
  {/if}

  {#if data.mode === 'trials'}
    {#if data.trial.kind === 'question'}
      <div class="column">
        <p class="question" title={data.trial.prompt}>
          <span class="eyebrow">Question ·</span>
          <span class="text">{data.trial.prompt}</span>
        </p>
        <div class="stagewrap">
          {#key data.trial.item.referenceId}
            <ImageStage
              src={data.trial.item.src}
              width={data.trial.item.width}
              height={data.trial.item.height}
              alt="The subject of this trial"
            />
          {/key}
          {@render levelToast(true)}
        </div>
        <div class="controls">
          <form class="answers" method="POST" action="?/trial" use:enhance={submitTrial}>
            <input type="hidden" name="questionKey" value={data.trial.questionKey} />
            <input type="hidden" name="referenceId" value={data.trial.item.referenceId} />
            {#each data.trial.options as option, index (option.value)}
              {@render pill(option, index, false)}
            {/each}
          </form>
          <button type="button" class="quiet guide" onclick={() => (guideReopened = true)}>Rating guide</button>
        </div>
        {#if formMessage}
          <p class="notice flat" role="alert">{formMessage}</p>
        {/if}
      </div>
    {:else if data.trial.kind === 'summary'}
      {@render levelToast(false)}
      <TrialSummary
        summary={data.trial}
        message={formMessage}
        {submitting}
        {submit}
      />
    {:else}
      <div class="panel">
        {@render levelToast(false)}
        {#if data.trial.kind === 'cooldown'}
          <p>Your last trial fell short. Return after {new Date(data.trial.until).toUTCString()}.</p>
        {:else}
          <p>The trials are not set out yet. Return later.</p>
        {/if}
      </div>
    {/if}
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
  {:else if data.item && data.question}
    <div class="column">
      {#if data.banner}
        <p class="banner" role="status">New questions: {data.banner.heading}</p>
      {/if}
      <p class="question" title={data.question.prompt}>
        <span class="eyebrow">Question ·</span>
        <span class="text">{data.question.prompt}</span>
      </p>
      <div class="stagewrap">
        {#key data.item.id}
          {@const itemId = data.item.id}
          <ImageStage
            src={data.item.src}
            width={data.item.width}
            height={data.item.height}
            alt="The subject of this judgment"
            failed={imageFailed}
            onfail={() => (failedItem = itemId)}
          />
        {/key}
        {@render levelToast(true)}
      </div>
      <div class="controls" class:yesno={yesNo} class:failed={imageFailed}>
        <form class="answers" method="POST" action="?/vote" use:enhance={submit} bind:this={answers}>
          <input type="hidden" name="item" value={data.item.id} />
          {#each data.question.options as option, index (option.value)}
            {@render pill(option, index, imageFailed)}
          {/each}
        </form>
        <form class="skip" method="POST" action="?/skip" use:enhance={submit} bind:this={skipForm}>
          <input type="hidden" name="item" value={data.item.id} />
          <button type="submit" class="quiet" disabled={submitting}>
            Skip<span class="space">&nbsp;·&nbsp;Space</span>
          </button>
        </form>
        {#if !yesNo}
          <button type="button" class="quiet guide" onclick={() => (guideReopened = true)}>Rating guide</button>
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
    voteWeight={data.progress.voteWeight}
    goldMultiplier={data.progress.goldMultiplier}
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
  .recap {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
    width: 100%;
    max-width: 48rem;
    margin: 0 auto 0.5rem;
    padding: 0 1.5rem 0 1rem;
    border-left: 3px solid var(--gold);
  }
  .recap p {
    margin: 0;
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
    align-items: center;
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
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .banner {
    flex: none;
    margin: 0;
    padding: 0.25rem 0.75rem;
    border-left: 3px solid var(--gold);
    color: var(--gold);
    font: 600 13px/1.3 var(--io-font-ui);
  }

  .controls {
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
  .quiet.guide {
    color: var(--io-gold);
  }
  .quiet.guide:hover:not(:disabled) {
    color: var(--io-parchment);
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
    .quiet.guide {
      margin-left: auto;
    }
    .space {
      display: none;
    }
    .panel {
      padding: 0.5rem 1rem 1.5rem;
    }
    .recap {
      padding-right: 1rem;
      font-size: 0.85rem;
    }
  }
</style>
