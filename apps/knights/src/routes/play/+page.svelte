<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import type { SubmitFunction } from '@sveltejs/kit';
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
        if (result.type === 'failure') await invalidateAll();
      } finally {
        submitting = false;
      }
    };
  };
</script>

<h1>Knights of New Order</h1>

{#if data.status}
  {@const status = data.status}
  <p class="status">
    {status.rank} · Level {status.level} · {status.xpIntoLevel}/{status.xpForNextLevel} XP
    {#if data.mode === 'trials' && data.trial.kind === 'question' && !showReveal}
      · Trial {data.trial.run.position} of {data.trial.run.total}
    {/if}
  </p>
  <div class="bar" aria-hidden="true">
    <div class="fill" style:width="{status.progressPercent}%"></div>
  </div>
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

    {#if form?.message}
      <p class="notice" role="status">{form.message}</p>
    {/if}
  {:else if data.trial.kind === 'cooldown'}
    <p>Your last trial fell short. Return after {new Date(data.trial.until).toUTCString()}.</p>
  {:else}
    <p>The trials are not set out yet. Return later.</p>
  {/if}
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

  {#if form?.message}
    <p class="notice" role="status">{form.message}</p>
  {/if}
{:else}
  <p>Nothing awaits your judgment right now. Return later.</p>
{/if}

<p><a href="/">Back</a></p>

<style>
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
  button {
    padding: 0.5rem 1.25rem;
    border: 1px solid var(--gold);
    background: var(--panel);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: var(--border);
  }
  button:disabled {
    opacity: 0.5;
    cursor: wait;
  }
  .notice {
    color: var(--gold);
  }
  .status {
    margin: 0 0 0.25rem;
    color: var(--muted);
  }
  .bar {
    height: 4px;
    margin-bottom: 1rem;
    background: var(--border);
  }
  .fill {
    height: 100%;
    background: var(--gold);
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
