<script lang="ts">
  import { enhance } from '$app/forms';
  import Icon from '$lib/Icon.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let saving = $state(false);
  // The switch flips at the click; the saved value replaces it once the page reloads, or it flips back on a failure.
  let pending = $state<boolean | null>(null);
  // The value the last save stored; the switch shows it without reloading the page.
  let savedOn = $state<boolean | null>(null);
  let saved = $state<boolean | null>(null);
  let error = $state<string | null>(null);
</script>

<svelte:head>
  <title>Settings · Knights of New Order</title>
</svelte:head>

<div class="settings">
  <header>
    <p class="eyebrow">Knights of New Order</p>
    <h1 class="page-title">Settings</h1>
    <p class="lede">Choose what Knights serves you. Changes apply from your next image.</p>
  </header>

  <section aria-labelledby="questions-title">
    <h2 id="questions-title">Questions</h2>
    <div class="rows">
      <div class="row">
        <div class="text">
          <p class="label">
            <span id="questions-label">Yes/no questions</span>
            <span class="beta">Beta</span>
          </p>
          {#if data.questions.available}
            <p class="description">
              Between ratings, some images ask a yes or no question. Turn this off to rate only.
            </p>
            <p class="note">
              <Icon name="info" size={13} />Available while Knights is in beta. Questions may become part
              of every Watch later.
            </p>
          {:else}
            <p class="description">
              Acolytes answer practice questions as part of their training. You can turn yes/no questions
              off once you are a Knight.
            </p>
          {/if}
        </div>
        {#if data.questions.available}
          {@const on = pending ?? savedOn ?? data.questions.on}
          <form
            method="POST"
            action="?/questions"
            use:enhance={({ formData }) => {
              pending = formData.get('questions') === 'on';
              saving = true;
              error = null;
              saved = null;
              return async ({ result, update }) => {
                try {
                  if (result.type === 'success') {
                    saved = result.data?.questions === true;
                    savedOn = saved;
                  } else if (result.type === 'failure') {
                    error = String(result.data?.message ?? 'Your choice was not saved. Try again.');
                  } else {
                    await update();
                  }
                } catch {
                  error = 'Your choice was not saved. Try again.';
                } finally {
                  saving = false;
                  pending = null;
                }
              };
            }}
          >
            <input type="hidden" name="questions" value={on ? 'off' : 'on'} />
            <button
              type="submit"
              class="switch"
              role="switch"
              aria-checked={on}
              aria-labelledby="questions-label"
              disabled={saving}
            >
              <span class="knob"></span>
            </button>
          </form>
        {/if}
      </div>
    </div>
    <p class="status" role="status">
      {#if error}
        <span class="error">{error}</span>
      {:else if saved !== null}
        <Icon name="check" size={13} />Saved. Questions are {saved ? 'on' : 'off'} from your next image.
      {/if}
    </p>
  </section>
</div>

<style>
  .settings {
    max-width: 45rem;
    margin: 0 auto;
    padding-top: 1rem;
  }

  section {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }

  h2 {
    margin: 0;
    color: var(--io-gold);
    font: 700 0.875rem/1.3 var(--io-font-display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .rows {
    border: 1px solid color-mix(in srgb, var(--io-gold-muted) 55%, transparent);
    border-radius: 8px;
    background: var(--io-surface);
  }

  .row {
    display: flex;
    gap: 1rem;
    align-items: center;
    padding: 1rem 1.125rem;
  }

  .text {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  .label {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin: 0;
    color: var(--io-parchment);
    font: 600 0.95rem/1.3 var(--io-font-ui);
  }

  .beta {
    padding: 0.125rem 0.5rem;
    border: 1px solid var(--io-gold-muted);
    border-radius: 999px;
    background: color-mix(in srgb, var(--io-gold) 14%, transparent);
    color: var(--io-gold);
    font: 600 0.625rem/1.3 var(--io-font-ui);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .description {
    margin: 0;
    color: var(--io-parchment-muted);
    font: 1rem/1.35 var(--io-font-body);
  }

  .note {
    display: flex;
    gap: 0.375rem;
    align-items: center;
    margin: 0.25rem 0 0;
    color: var(--io-parchment-muted);
    font: 0.75rem/1.4 var(--io-font-ui);
  }

  .note :global(svg) {
    flex: none;
    color: var(--io-gold-muted);
  }

  .switch {
    display: flex;
    flex: none;
    align-items: center;
    width: 2.75rem;
    min-width: 0;
    height: 1.5rem;
    min-height: 0;
    padding: 2px;
    border: 1px solid color-mix(in srgb, var(--io-gold-muted) 55%, transparent);
    border-radius: 999px;
    background: var(--io-matte);
    cursor: pointer;
  }

  .switch[aria-checked='true'] {
    justify-content: flex-end;
    border-color: var(--io-gold);
    background: var(--io-gold);
  }

  .switch:hover:not(:disabled) {
    border-color: var(--io-gold);
    background: var(--io-matte);
  }

  .switch[aria-checked='true']:hover:not(:disabled) {
    border-color: var(--io-parchment);
    background: var(--io-gold);
  }

  .switch:disabled {
    cursor: progress;
    opacity: 0.6;
  }

  .switch:focus-visible {
    outline: 2px solid var(--io-gold);
    outline-offset: 2px;
  }

  .knob {
    width: 1.125rem;
    height: 1.125rem;
    border-radius: 50%;
    background: var(--io-parchment-muted);
  }

  .switch[aria-checked='true'] .knob {
    background: var(--io-bg);
  }

  .status {
    display: flex;
    gap: 0.375rem;
    align-items: center;
    min-height: 1.1rem;
    margin: 0;
    color: var(--io-parchment-muted);
    font: 0.75rem/1.4 var(--io-font-ui);
  }

  .status :global(svg) {
    color: var(--io-verdigris);
  }

  .error {
    color: var(--io-crimson-text);
  }
</style>
