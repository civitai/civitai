<script lang="ts">
  import { enhance } from '$app/forms';
  import { dev } from '$app/environment';
  import { invalidate } from '$app/navigation';
  import type { SubmitFunction } from '@sveltejs/kit';
  import DailyPanel from './DailyPanel.svelte';
  import Countdown from '$lib/Countdown.svelte';
  import { recapLines } from './recap-text';
  import StatusBar from '$lib/StatusBar.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  let submitting = $state(false);
  let dismissed = $state.raw<unknown>(null);
  let showReveal = $derived(form?.reveal !== undefined && form !== dismissed);

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

<h1>Knights of New Order</h1>

<StatusBar status={data.status}>
  {#snippet position()}
    {#if data.mode === 'trials' && data.trial.kind === 'question' && !showReveal}
      · Trial {data.trial.run.position} of {data.trial.run.total}
    {/if}
  {/snippet}
  {#snippet links()}
    · <a href="/judgments">Your judgments</a>
    {#if dev}· <a href="/dev/simulate">Simulate other voters</a>{/if}
  {/snippet}
</StatusBar>

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

{#if showReveal && form?.reveal}
  <div class="reveal" role="status" class:right={form.reveal.correct}>
    <img src={form.reveal.src} alt="The subject you just judged" />
    <p class="verdict">{form.reveal.correct ? 'Rightly judged.' : 'Not quite.'}</p>
    <p>The answer: {form.reveal.correctLabel}</p>
    {#if form.reveal.explanation}
      <p class="explanation">{form.reveal.explanation}</p>
    {/if}
    {#if form.reveal.finished?.result === 'passed'}
      <p class="verdict">You are now a Knight of New Order.</p>
    {:else if form.reveal.finished?.result === 'failed'}
      <p class="verdict">Your trial is over, and it was not enough. You may try again later.</p>
    {:else if form.reveal.finished}
      <p class="verdict">
        Some images of this trial were withdrawn, so it could not be judged. A new trial awaits.
      </p>
    {/if}
    <button type="button" onclick={() => (dismissed = form)}>Continue</button>
  </div>
{:else if data.mode === 'trials'}
  {#if data.trial.kind === 'question'}
    <p class="prompt">{data.trial.prompt}</p>
    {#key data.trial.item.referenceId}
      <img
        src={data.trial.item.src}
        width={data.trial.item.width ?? undefined}
        height={data.trial.item.height ?? undefined}
        alt="The subject of this trial"
      />
    {/key}

    <form method="POST" action="?/trial" use:enhance={submit}>
      <input type="hidden" name="questionKey" value={data.trial.questionKey} />
      <input type="hidden" name="referenceId" value={data.trial.item.referenceId} />
      <div class="options">
        {#each data.trial.options as option (option.value)}
          <button type="submit" name="answer" value={option.value} disabled={submitting}>
            {option.label}
          </button>
        {/each}
      </div>
    </form>

    {#if form?.message && !form.recapFailed}
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
  <p class="prompt">{data.question.prompt}</p>
  {#key data.item.id}
    <img
      src={data.item.src}
      width={data.item.width ?? undefined}
      height={data.item.height ?? undefined}
      alt="The subject of this judgment"
    />
  {/key}

  <form method="POST" action="?/vote" use:enhance={submit}>
    <input type="hidden" name="itemId" value={data.item.id} />
    <div class="options">
      {#each data.question.options as option (option.value)}
        <button type="submit" name="answer" value={option.value} disabled={submitting}>
          {option.label}
        </button>
      {/each}
    </div>
  </form>

  {#if form?.message && !form.recapFailed}
    <p class="notice" role="alert">{form.message}</p>
  {/if}
{:else}
  <p>Nothing awaits your judgment right now. Return later.</p>
{/if}

<p><a href="/">Back</a></p>

<style>
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
  img {
    display: block;
    max-width: 100%;
    max-height: 70vh;
    height: auto;
    object-fit: contain;
    margin: 1rem 0;
    border: 1px solid var(--border);
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
  .explanation {
    color: var(--muted);
  }
</style>
