<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import Icon from '$lib/Icon.svelte';
  import { modal } from '$lib/modal';
  import { recapView } from '$lib/recap-view';
  import type { Recap } from '$lib/server/daily/daily.service';
  import '$lib/overlay.css';

  let {
    recap,
    action,
    message,
    submitting,
    submit,
  }: {
    /** Null when the player has no play day to recap yet. */
    recap: Recap | null;
    action: string;
    /** A failure to show instead of, or under, the recap. */
    message: string | null;
    submitting: boolean;
    submit: SubmitFunction;
  } = $props();

  let form = $state<HTMLFormElement>();
  let view = $derived(recap ? recapView(recap) : null);
  let headline = $derived(
    view?.headline ?? (message ? 'Your verdicts could not be loaded' : 'No verdicts yet')
  );

  // Escape, like the X, closes the dialog and so dismisses today's recap.
  const close = () => {
    if (!submitting) form?.requestSubmit();
  };
</script>

<div class="ov-backdrop">
  <div
    class="recap"
    role="dialog"
    aria-modal="true"
    aria-labelledby="recap-title"
    tabindex="-1"
    use:modal={{ onescape: close }}
  >
    <form method="POST" {action} use:enhance={submit} bind:this={form}>
      <button type="submit" class="x" aria-label="Close" disabled={submitting}>
        <Icon name="x" size={20} />
      </button>
      <p class="ov-eyebrow">Your verdicts are in</p>
      <h2 id="recap-title">{headline}</h2>

      {#if view}
        <ul class="stats" aria-label="Yesterday's judgments">
          {#each view.stats as stat (stat.key)}
            <li class={stat.key}>
              <span class="label">{stat.label}</span>
              <span class="value">{stat.value}</span>
              <span class="note">{stat.note}</span>
            </li>
          {/each}
        </ul>
        <div class="payout">
          <Icon name="coins" size={24} />
          <div>
            <p class="gold">{view.payout.gold}</p>
            <p class="note">{view.payout.note}</p>
          </div>
        </div>
      {:else if !message}
        <p class="empty">Play today's Watch and your verdicts will be waiting here tomorrow.</p>
      {/if}
      {#if message}
        <p class="error" role="alert">{message}</p>
      {/if}

      <button type="submit" name="begin" value="1" class="ov-primary begin" disabled={submitting} data-autofocus>
        Back to judging
      </button>
    </form>
  </div>
</div>

<style>
  .recap {
    width: min(100%, 720px);
    max-height: 100%;
    /* Room below the content for the focus rings the scroll container would otherwise clip. */
    padding: 1px;
    overflow-x: hidden;
    overflow-y: auto;
    border: 1px solid var(--io-gold);
    border-radius: 8px;
    background: var(--io-surface);
  }
  form {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 20px;
    min-width: 0;
    padding: 36px 40px 28px;
    text-align: center;
  }
  form > :global(*) {
    min-width: 0;
    max-width: 100%;
  }
  .x {
    position: absolute;
    top: 12px;
    right: 12px;
    display: grid;
    place-items: center;
    width: 40px;
    min-height: 40px;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: none;
    color: var(--io-parchment-muted);
  }
  .x:hover:not(:disabled) {
    background: var(--io-bg);
    color: var(--io-gold);
  }
  .ov-eyebrow {
    font-size: 13px;
  }
  h2 {
    margin: 0;
    color: var(--io-parchment);
    font: 700 36px/1.2 var(--io-font-display);
    overflow-wrap: anywhere;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
    width: 100%;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .stats li {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 16px 8px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 8px;
    background: var(--io-bg);
  }
  .label {
    color: var(--io-parchment-muted);
    font: 600 12px/1.2 var(--io-font-ui);
    letter-spacing: 2px;
    text-transform: uppercase;
  }
  .value {
    color: var(--io-parchment);
    font: 700 32px/1.1 var(--io-font-display);
  }
  .confirmed .value {
    color: var(--io-verdigris);
  }
  .missed .value {
    color: var(--io-crimson-text);
  }
  .undecided .value {
    color: var(--io-parchment-muted);
  }
  .note {
    margin: 0;
    color: var(--io-parchment-muted);
    font: 400 12px/1.3 var(--io-font-ui);
  }
  .payout {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 14px;
    width: 100%;
    padding: 16px 20px;
    border: 1px solid var(--io-gold);
    border-radius: 8px;
    background: var(--io-bg);
    text-align: left;
  }
  .payout :global(svg) {
    flex: none;
    color: var(--io-gold);
  }
  .payout p {
    margin: 0;
  }
  .gold {
    color: var(--io-gold);
    font: 700 22px/1.2 var(--io-font-display);
  }
  .empty {
    margin: 0;
    color: var(--io-parchment-muted);
    font: 400 20px/1.4 var(--io-font-body);
  }
  .error {
    margin: 0;
    color: var(--io-crimson-text);
    font: 400 14px/1.4 var(--io-font-ui);
  }

  /* On a phone the stats sit two by two and the button is pinned to the bottom. */
  @media (max-width: 40rem) {
    :global(.ov-backdrop:has(.recap)) {
      padding: 16px 16px 88px;
    }
    .recap {
      width: 100%;
    }
    form {
      gap: 16px;
      padding: 40px 16px 12px;
    }
    h2 {
      font-size: 24px;
    }
    .stats {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .begin {
      position: fixed;
      right: 16px;
      bottom: max(16px, env(safe-area-inset-bottom));
      left: 16px;
      width: auto;
    }
  }
</style>
