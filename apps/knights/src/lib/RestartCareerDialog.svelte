<script lang="ts">
  import { onMount } from 'svelte';
  import { goto, invalidateAll } from '$app/navigation';
  import Icon from './Icon.svelte';
  import { modal } from './modal';
  import './overlay.css';

  let { onclose }: { onclose: () => void } = $props();

  let losses = $state<{ title: string; detail: string }[] | null>(null);
  let message = $state<string | null>(null);
  let submitting = $state(false);

  const cancel = () => {
    if (!submitting) onclose();
  };

  onMount(async () => {
    try {
      const response = await fetch('/career');
      if (!response.ok) throw new Error(String(response.status));
      losses = (await response.json()).losses ?? [];
    } catch {
      message = 'Could not load what a restart would take. Try again in a moment.';
      losses = [];
    }
  });

  async function restart() {
    submitting = true;
    message = null;
    try {
      const body = new FormData();
      body.set('confirmed', 'yes');
      const response = await fetch('/career', { method: 'POST', body });
      const result = (await response.json().catch(() => null)) as {
        ok?: boolean;
        message?: string;
        to?: string;
      } | null;
      if (response.ok && result?.ok && result.to) {
        await invalidateAll();
        onclose();
        await goto(result.to, { invalidateAll: true });
        return;
      }
      message = result?.message ?? 'Your career could not be restarted. Try again in a moment.';
    } catch {
      message = 'Your career could not be restarted. Try again in a moment.';
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
    aria-labelledby="restart-title"
    tabindex="-1"
    use:modal={{ onescape: cancel }}
  >
    <p class="ov-eyebrow crimson">Restart career</p>
    <h2 id="restart-title">Begin again as an Acolyte?</h2>
    <p class="strong">Restarting your career cannot be undone. You will lose:</p>
    {#if losses}
      <ul>
        {#each losses as loss (loss.title)}
          <li>
            <span class="x"><Icon name="x" size={18} /></span>
            <div>
              <p class="loss-title">{loss.title}</p>
              <p class="muted">{loss.detail}</p>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
    <p class="kept"><Icon name="shield-check" size={18} />Gold you have already spent or converted stays with you.</p>
    {#if message}
      <p class="notice" role="alert">{message}</p>
    {/if}
    <div class="actions">
      <button type="button" class="btn danger solid" disabled={submitting || !losses} onclick={restart}>
        Yes, restart my career
      </button>
      <button type="button" class="btn" disabled={submitting} onclick={cancel} data-autofocus>Cancel</button>
    </div>
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
    border: 1px solid var(--io-crimson-text);
    border-radius: 8px;
    background: var(--io-surface);
  }
  h2 {
    margin: 0;
  }
  p {
    margin: 0;
  }
  .strong,
  .loss-title {
    color: var(--io-parchment);
  }
  ul {
    margin: 4px 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    gap: 0.75rem;
    padding: 0.5rem 0;
  }
  .x {
    padding-top: 0.1rem;
    color: var(--io-crimson-text);
  }
  .kept {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 4px 0 8px;
  }
  .kept :global(svg) {
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
