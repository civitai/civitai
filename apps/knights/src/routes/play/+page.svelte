<script lang="ts">
  import { enhance } from '$app/forms';
  import { dev } from '$app/environment';
  import { invalidate, invalidateAll } from '$app/navigation';
  import type { SubmitFunction } from '@sveltejs/kit';
  import DailyPanel from './DailyPanel.svelte';
  import Countdown from '$lib/Countdown.svelte';
  import { recapLines } from './recap-text';
  import { answerForKey, keyHints } from './keys';
  import StatusBar from '$lib/StatusBar.svelte';
  import RatingGuide from '$lib/RatingGuide.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  let submitting = $state(false);
  type Reveal = NonNullable<Extract<NonNullable<ActionData>, { reveal: unknown }>['reveal']>;
  // Held here, not read back from `form`: answering the last Trial promotes the player and reloads the page as a Knight's,
  // and the result of that answer must still be shown first.
  let reveal = $state.raw<Reveal | null>(null);
  let showReveal = $derived(reveal !== null);
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
  let failedItem = $state<string | null>(null);
  let imageFailed = $derived(data.mode === 'queue' && !!data.item && failedItem === data.item.id);

  // The load event can fire before this page is interactive, so a frame that already failed is checked once on mount.
  function watchImage(img: HTMLImageElement, onfail: () => void) {
    if (img.complete && img.naturalWidth === 0) onfail();
    img.addEventListener('error', onfail);
    return { destroy: () => img.removeEventListener('error', onfail) };
  }

  // Y and N answer a yes/no question, the number keys a rating, and Space skips the item, even while an answer button has focus (the browser would
  // otherwise press it). Typing in a field or holding a modifier is left alone.
  function onkeydown(event: KeyboardEvent) {
    if (data.mode !== 'queue' || !data.item || submitting) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable]')) return;
    if (event.key === ' ') {
      event.preventDefault();
      skipForm?.requestSubmit();
      return;
    }
    if (imageFailed || !data.question) return;
    const value = yesNo
      ? { y: 'yes', n: 'no' }[event.key.toLowerCase()]
      : answerForKey(data.question.options, event.key);
    if (value) answers?.querySelector<HTMLButtonElement>(`button[value="${value}"]`)?.click();
  }

  const submitTrial: SubmitFunction = () => {
    submitting = true;
    return async ({ result, update }) => {
      try {
        if (result.type === 'success' && result.data?.reveal) {
          reveal = result.data.reveal as Reveal;
        } else {
          await update();
          if (result.type === 'failure') await invalidate('app:play');
        }
      } finally {
        submitting = false;
      }
    };
  };

  async function continueFromReveal() {
    reveal = null;
    await invalidateAll();
  }

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

  const submit: SubmitFunction = () => {
    submitting = true;
    return async ({ result, update }) => {
      try {
        await update();
        // A refused answer doesn't re-run `load`; refetch or the refused item stays on screen.
        if (result.type === 'failure') await invalidate('app:play');
      } finally {
        submitting = false;
      }
    };
  };
</script>

<svelte:window {onkeydown} />

<div class="play">
  <h1>Knights of New Order</h1>

  <StatusBar status={data.status}>
    {#snippet position()}
      {#if data.mode === 'trials' && data.trial.kind === 'question' && !showReveal}
        · Trial {data.trial.run.position} of {data.trial.run.total}
      {/if}
    {/snippet}
    {#snippet links()}
      · <a href="/judgments">Your judgments</a>
      {#if data.conversionOpen}· <a href="/gold">Convert gold</a>{/if}
      {#if dev}· <a href="/dev/simulate">Simulate other voters</a>{/if}
    {/snippet}
  </StatusBar>

  {#if data.resetNotice}
    <section class="recap" role="status" aria-label="Career reset">
      <div>
        <p class="verdict">Your career has been reset.</p>
        <p>
          {data.status.maxSmites} smites were more than the Order would bear. You are an Acolyte again at level 1,
          and the Trials await.
        </p>
        {#if form?.resetNoticeFailed}
          <p>{form.message}</p>
        {/if}
      </div>
      <form method="POST" action="?/dismissResetNotice" use:enhance={submit}>
        <button type="submit" disabled={submitting}>Understood</button>
      </form>
    </section>
  {:else if data.mode === 'queue' && data.resetPending}
    <p class="notice" role="alert">Your career is being reset. Return in a moment.</p>
  {/if}
  {#if data.notices.length > 0}
    <section class="recap" role="status" aria-label="Sanity check">
      <div>
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

  {#if data.mode === 'queue'}
    {#if data.recap}
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
    <DailyPanel daily={data.daily} />
  {/if}

  {#if reveal}
    <div class="reveal" role="status" class:right={reveal.correct}>
      <img src={reveal.src} alt="The subject you just judged" />
      <p class="verdict">{reveal.correct ? 'Rightly judged.' : 'Not quite.'}</p>
      <p>The answer: {reveal.correctLabel}</p>
      {#if reveal.explanation}
        <p class="explanation">{reveal.explanation}</p>
      {/if}
      {#if reveal.finished?.result === 'passed'}
        <section class="promotion" aria-label="Trials passed">
          <p class="verdict">You have passed the Trials.</p>
          <p>You are now a Knight of New Order. Continue to begin judging.</p>
        </section>
      {:else if reveal.finished?.result === 'failed'}
        <p class="verdict">Your trial is over, and it was not enough. You may try again later.</p>
      {:else if reveal.finished}
        <p class="verdict">
          Some images of this trial were withdrawn, so it could not be judged. A new trial awaits.
        </p>
      {/if}
      <button type="button" onclick={continueFromReveal}>
        {reveal.finished?.result === 'passed' ? 'Enter the Order' : 'Continue'}
      </button>
    </div>
  {:else if data.mode === 'trials'}
    {#if data.trial.kind === 'question'}
      <p class="prompt">{data.trial.prompt}</p>
      <div class="frame">
        {#key data.trial.item.referenceId}
          <img
            src={data.trial.item.src}
            width={data.trial.item.width ?? undefined}
            height={data.trial.item.height ?? undefined}
            alt="The subject of this trial"
          />
        {/key}
      </div>

      <form method="POST" action="?/trial" use:enhance={submitTrial}>
        <input type="hidden" name="questionKey" value={data.trial.questionKey} />
        <input type="hidden" name="referenceId" value={data.trial.item.referenceId} />
        <div class="options">
          {#each data.trial.options as option (option.value)}
            <button
              type="submit"
              name="answer"
              value={option.value}
              title={levelHint.get(option.value)}
              disabled={submitting}
            >
              {option.label}
            </button>
          {/each}
        </div>
      </form>

      <p class="skip"><button type="button" onclick={() => (guideReopened = true)}>Rating guide</button></p>

      {#if form?.message && !form.recapFailed && !form.resetNoticeFailed && !form.noticeFailed && !form.guideFailed && !form.progressFailed}
        <p class="notice" role="alert">{form.message}</p>
      {/if}
    {:else if data.trial.kind === 'cooldown'}
      <p>Your last trial fell short. Return after {new Date(data.trial.until).toUTCString()}.</p>
    {:else}
      <p>The trials are not set out yet. Return later.</p>
    {/if}
  {:else if data.mode === 'queue' && data.lockoutSeconds}
    <section class="lockout" role="status" aria-label="Judging paused">
      <h2>A moment of rest</h2>
      <p>You have been judging faster than the Order can trust. Rest a little; the queue will wait.</p>
      <Countdown seconds={data.lockoutSeconds} label="Time until judging resumes" />
      <p class="muted">Judging resumes by itself.</p>
    </section>
  {:else if data.item && data.question}
    {#if data.banner}
      <p class="banner" role="status">New questions: {data.banner.heading}</p>
    {/if}
    <p class="prompt">{data.question.prompt}</p>
    <div class="frame">
      {#key data.item.id}
        {@const itemId = data.item.id}
        <img
          src={data.item.src}
          width={data.item.width ?? undefined}
          height={data.item.height ?? undefined}
          alt="The subject of this judgment"
          use:watchImage={() => (failedItem = itemId)}
        />
      {/key}
    </div>
    {#if imageFailed}
      <p class="notice" role="alert">This image could not be loaded. Skip it to see the next one.</p>
    {/if}

    <form method="POST" action="?/vote" use:enhance={submit} bind:this={answers}>
      <input type="hidden" name="item" value={data.item.id} />
      <div class="options">
        {#each data.question.options as option, index (option.value)}
          <button
            type="submit"
            name="answer"
            value={option.value}
            title={levelHint.get(option.value)}
            disabled={submitting || imageFailed}
          >
            {option.label}<kbd>{yesNo ? option.label[0] : index + 1}</kbd>
          </button>
        {/each}
      </div>
    </form>

    <p class="hint">
      Keys:
      {#if yesNo}Y yes · N no{:else}{#each keyHints(data.question.options) as hint (hint.key)}{hint.key} {hint.label} ·
        {/each}{/if}
      Space skips
    </p>
    <form method="POST" action="?/skip" use:enhance={submit} bind:this={skipForm} class="skip">
      <input type="hidden" name="item" value={data.item.id} />
      <button type="submit" disabled={submitting}>Skip <kbd>Space</kbd></button>
      {#if !yesNo}
        <button type="button" onclick={() => (guideReopened = true)}>Rating guide</button>
      {/if}
    </form>

    {#if form?.message && !form.recapFailed && !form.resetNoticeFailed && !form.noticeFailed && !form.guideFailed && !form.progressFailed}
      <p class="notice" role="alert">{form.message}</p>
    {/if}
  {:else if !data.resetPending}
    <p>Nothing awaits your judgment right now. Return later.</p>
  {/if}

  <p class="back"><a href="/">Back</a></p>
</div>

{#if guideOpen}
  <div class="overlay">
    <div class="dialog" role="dialog" aria-modal="true" aria-label="Rating guide">
      <h2>Rating guide</h2>
      <p class="muted">What each level means. Rate what the image shows, not what you would like to see.</p>
      <RatingGuide guide={data.ratingGuide} />
      {#if form?.guideFailed}
        <p class="notice" role="alert">{form.message}</p>
      {/if}
      <form method="POST" action="?/dismissGuide" use:enhance={submitGuide}>
        <button type="submit" disabled={submitting}>I understand</button>
      </form>
    </div>
  </div>
{:else if data.progress}
  <div class="overlay">
    <div class="dialog" role="dialog" aria-modal="true" aria-label="Your progress">
      {#if data.progress.kind === 'rank'}
        <p class="verdict">You have risen to {data.progress.rank}.</p>
        <p>You are now a {data.progress.rank} of the Order, at level {data.progress.level}.</p>
      {:else}
        <p class="verdict">You have reached level {data.progress.level}.</p>
        <p>The Order grows in respect for your judgment.</p>
      {/if}
      {#if form?.progressFailed}
        <p class="notice" role="alert">{form.message}</p>
      {/if}
      <form method="POST" action="?/dismissProgress" use:enhance={submit}>
        <button type="submit" disabled={submitting}>Onward</button>
      </form>
    </div>
  </div>
{/if}

<style>
  /* Floats over the page so a notice never pushes the answer buttons off a phone screen. */
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    background: rgb(0 0 0 / 0.7);
  }
  .dialog {
    max-width: 32rem;
    max-height: 100%;
    overflow-y: auto;
    padding: 1rem 1.25rem;
    border: 1px solid var(--gold);
    background: var(--panel);
  }
  .dialog h2 {
    margin-top: 0;
  }
  .lockout {
    padding: 1rem 1.5rem;
    border: 1px solid var(--border);
    background: var(--panel);
    text-align: center;
  }
  .recap {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
    margin-bottom: 1rem;
    padding-left: 1rem;
    border-left: 3px solid var(--gold);
  }
  .recap p {
    margin: 0;
  }
  .prompt {
    font-size: 1.15rem;
  }
  .banner {
    margin: 0 0 0.5rem;
    padding: 0.25rem 0.75rem;
    border-left: 3px solid var(--gold);
    color: var(--gold);
  }
  kbd {
    margin-left: 0.4rem;
    opacity: 0.7;
    font-size: 0.8em;
  }
  img {
    display: block;
    max-width: 100%;
    max-height: 70vh;
    height: auto;
    object-fit: contain;
    margin: 1rem 0;
    border: 1px solid var(--border);
  }
  .hint {
    margin: 0.5rem 0 0;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .skip {
    margin-top: 0.5rem;
  }
  .options {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .reveal {
    border-left: 3px solid var(--border);
    padding-left: 1rem;
  }
  .reveal.right {
    border-left-color: var(--gold);
  }
  .verdict {
    color: var(--gold);
  }
  .promotion {
    margin: 1rem 0;
    padding: 0.5rem 1rem;
    border: 1px solid var(--gold);
  }
  .explanation {
    color: var(--muted);
  }

  /* On a phone the image takes whatever height the rest of the page leaves, so the answers stay on screen. */
  @media (max-width: 40rem) {
    .play {
      display: flex;
      flex-direction: column;
      min-height: calc(100vh - var(--chrome));
      min-height: calc(100dvh - var(--chrome));
    }
    h1 {
      margin: 0.25rem 0;
    }
    .frame {
      position: relative;
      flex: 1 1 0;
      min-height: 8rem;
      margin: 0.5rem 0;
    }
    .frame img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      max-height: none;
      margin: 0;
    }
    .prompt {
      margin: 0.25rem 0 0;
      font-size: 1rem;
      line-height: 1.3;
    }
    .recap {
      margin-bottom: 0.5rem;
      gap: 0.25rem 0.75rem;
      font-size: 0.85rem;
    }
    .options {
      gap: 0.4rem;
    }
    .options button {
      flex: 1 1 4.5rem;
      padding-inline: 0.4rem;
    }
    .skip {
      margin-top: 0.4rem;
    }
    .skip {
      display: flex;
      gap: 0.4rem;
    }
    .skip button {
      flex: 1 1 0;
    }
    kbd,
    .hint {
      display: none;
    }
    .back {
      margin: 0.5rem 0 0;
    }
    .reveal img {
      max-height: 40vh;
      margin: 0.5rem 0;
    }
  }
</style>
