<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import StatusBar from '$lib/StatusBar.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  let submitting = $state(false);

  const submit: SubmitFunction = () => {
    submitting = true;
    return async ({ update }) => {
      try {
        await update();
      } finally {
        submitting = false;
      }
    };
  };
</script>

<h1>Simulate other voters</h1>
<p class="muted">
  Development only. Casts votes from other Knights players, through the normal voting path, until the
  item is settled.
</p>

<StatusBar status={data.status} />

<form method="POST" action="?/setLevel" use:enhance={submit} class="level">
  <label>
    Set my level
    <input type="number" name="level" min="1" value={data.status.level} required />
  </label>
  <button type="submit" disabled={submitting}>Set level</button>
  <span class="muted">Applies the rank-up that level and your recorded accuracy earn.</span>
</form>

{#if form?.message}
  <p class="notice" role="alert">{form.message}</p>
{:else if form?.success && form.levelSet}
  <p class="notice" role="status">You are now level {form.levelSet}, {form.rank}.</p>
{:else if form?.success}
  <p class="notice" role="status">
    Item #{form.itemId}: {form.cast} votes cast. It is now {form.itemStatus}{form.settled
      ? '.'
      : ', its rating is still to be written back; run the tick job.'}
  </p>
{/if}

{#each data.items as item (item.id)}
  <form method="POST" action="?/simulate" use:enhance={submit} class="item">
    <img src={item.src} alt="Subject of item {item.id}" width="96" />
    <div>
      <p>
        #{item.id} · {item.prompt}
        <span class="muted">· {item.stage} · {item.votes} votes{item.votedByMe ? ' · you voted' : ''}</span>
      </p>
      <input type="hidden" name="itemId" value={item.id} />
      {#each item.options as option (option.value)}
        <button type="submit" name="answer" value={option.value} disabled={submitting}>Resolve as {option.label}</button>
      {/each}
    </div>
  </form>
{:else}
  <p>No open items.</p>
{/each}

<p><a href="/play">Back</a></p>

<style>
  .level {
    margin: 1rem 0;
  }
  .level input {
    width: 5rem;
    margin: 0 0.5rem;
  }
  .item {
    display: flex;
    gap: 1rem;
    align-items: flex-start;
    margin: 1rem 0;
  }
  img {
    object-fit: cover;
    border: 1px solid var(--border);
  }
  button {
    margin: 0 0.5rem 0.5rem 0;
    padding: 0.35rem 0.9rem;
  }
</style>
