<script lang="ts">
  import { FEEDBACK_MESSAGE_MAX_LENGTH } from '@civitai/shared/feedback.constants';
  import { tick } from 'svelte';
  import { page } from '$app/state';
  import Icon from './Icon.svelte';
  import { modal } from './modal';
  import './overlay.css';

  let { onclose }: { onclose: () => void } = $props();

  let text = $state('');
  let message = $state<string | null>(null);
  let sent = $state(false);
  let submitting = $state(false);
  let closeButton = $state<HTMLButtonElement>();

  const trimmed = $derived(text.trim());
  const remaining = $derived(FEEDBACK_MESSAGE_MAX_LENGTH - text.length);

  const cancel = () => {
    if (!submitting) onclose();
  };

  async function send(event: SubmitEvent) {
    event.preventDefault();
    if (!trimmed || remaining < 0) return;
    submitting = true;
    message = null;
    try {
      const body = new FormData();
      body.set('message', trimmed);
      body.set('path', page.url.pathname);
      const response = await fetch('/feedback', { method: 'POST', body });
      const result = (await response.json().catch(() => null)) as {
        ok?: boolean;
        message?: string;
      } | null;
      if (response.ok && result?.ok) {
        sent = true;
        // The form is gone, so focus would fall to the page.
        await tick();
        closeButton?.focus();
        return;
      }
      message = result?.message ?? 'Your feedback could not be sent. Try again in a moment.';
    } catch {
      message = 'Your feedback could not be sent. Try again in a moment.';
    } finally {
      submitting = false;
    }
  }
</script>

<div class="ov-backdrop">
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="feedback-title"
    tabindex="-1"
    use:modal={{ onescape: cancel }}
  >
    <p class="ov-eyebrow">Feedback</p>
    {#if sent}
      <h2 id="feedback-title">Thank you</h2>
      <p class="done"><Icon name="circle-check" size={18} />Your feedback was sent to the team.</p>
      <div class="actions">
        <button type="button" class="btn" onclick={onclose} data-autofocus bind:this={closeButton}>Close</button>
      </div>
    {:else}
      <h2 id="feedback-title">Send feedback</h2>
      <form onsubmit={send}>
        <label for="feedback-text" class="muted">What went wrong, or what would make the game better?</label>
        <textarea
          id="feedback-text"
          rows="6"
          bind:value={text}
          disabled={submitting}
          data-autofocus
        ></textarea>
        <p class="count" class:over={remaining < 0}>{remaining.toLocaleString('en-US')} characters left</p>
        {#if message}
          <p class="notice" role="alert">{message}</p>
        {/if}
        <div class="actions">
          <button
            type="submit"
            class="btn primary"
            disabled={submitting || !trimmed || remaining < 0}
          >
            <Icon name="send" size={16} />Send
          </button>
          <button type="button" class="btn" disabled={submitting} onclick={cancel}>Cancel</button>
        </div>
      </form>
    {/if}
  </div>
</div>

<style>
  .dialog {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: min(100%, 32rem);
    max-height: 100%;
    padding: 28px;
    overflow-y: auto;
    border: 1px solid var(--io-gold-muted);
    border-radius: 8px;
    background: var(--io-surface);
  }
  h2,
  p {
    margin: 0;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  textarea {
    width: 100%;
    min-height: 8rem;
    padding: 0.75rem;
    border: 1px solid var(--io-gold-muted);
    border-radius: 6px;
    background: var(--io-bg);
    color: var(--io-parchment);
    font: 400 0.95rem/1.5 var(--io-font-ui);
    resize: vertical;
  }
  textarea:focus-visible {
    outline: 2px solid var(--io-gold);
    outline-offset: 1px;
  }
  .count {
    color: var(--io-parchment-muted);
    font: 400 0.8rem/1.3 var(--io-font-ui);
    text-align: right;
  }
  .count.over {
    color: var(--io-crimson-text);
  }
  .done {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .done :global(svg) {
    flex: none;
    color: var(--io-verdigris);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }
  @media (max-width: 40rem) {
    .actions .btn {
      flex: 1;
    }
  }
</style>
