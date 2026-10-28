<script lang="ts">
  import { enhance } from '$app/forms';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  let submitting = $state(false);
</script>

<h1>Knights of New Order</h1>

{#if data.item && data.question}
  <p class="prompt">{data.question.prompt}</p>
  <img src={data.item.src} alt="The subject of this judgment" />

  <form
    method="POST"
    action="?/vote"
    use:enhance={() => {
      submitting = true;
      return async ({ update }) => {
        await update();
        submitting = false;
      };
    }}
  >
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
    <p class="notice">{form.message}</p>
  {/if}
  <p class="muted">{data.remaining} left in this stretch</p>
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
  .muted {
    color: var(--muted);
  }
</style>
