<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import OverlayIcon from '$lib/OverlayIcon.svelte';
  import { modal } from '$lib/modal';
  import '$lib/overlay.css';

  let {
    rank,
    level,
    levels,
    voteWeight,
    goldMultiplier,
    message,
    submitting,
    submit,
  }: {
    rank: string;
    level: number;
    levels?: string;
    voteWeight?: number;
    goldMultiplier?: number;
    message: string | null;
    submitting: boolean;
    submit: SubmitFunction;
  } = $props();

  let form = $state<HTMLFormElement>();
  const close = () => {
    if (!submitting) form?.requestSubmit();
  };
</script>

<div class="ov-backdrop">
  <div
    class="rankup"
    role="dialog"
    aria-modal="true"
    aria-labelledby="rankup-title"
    tabindex="-1"
    use:modal={{ onescape: close }}
  >
    <section class="card">
      <p class="ov-eyebrow">Rank achieved</p>
      <span class="ov-crest crest"><OverlayIcon name="shield-plus" size={40} /></span>
      <p class="rank">{rank}</p>
      {#if levels}<p class="levels">Levels {levels}</p>{/if}
      <h2 id="rankup-title">You have risen to {rank}</h2>
      {#if voteWeight !== undefined && goldMultiplier !== undefined}
        <p class="lead">Your votes now weigh {voteWeight}x and your gold {goldMultiplier}x.</p>
      {:else}
        <p class="lead">You are now a {rank} of the Order, at level {level}.</p>
      {/if}
      {#if message}
        <p class="notice" role="alert">{message}</p>
      {/if}
    </section>
    <form method="POST" action="?/dismissProgress" use:enhance={submit} bind:this={form}>
      <button type="submit" class="ov-primary" disabled={submitting} data-autofocus>Onward</button>
    </form>
  </div>
</div>

<style>
  .rankup {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 24px;
    width: min(100%, 640px);
    max-height: 100%;
    overflow-y: auto;
  }
  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 36px 32px;
    border: 1px solid var(--io-gold);
    border-radius: 8px;
    background: linear-gradient(180deg, #3a2c10, var(--io-surface));
    text-align: center;
  }
  .crest {
    width: 90px;
    height: 90px;
    margin: 8px 0 2px;
  }
  .rank {
    margin: 0;
    color: var(--io-parchment);
    font: 700 18px/1.2 var(--io-font-display);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .levels {
    margin: 0;
    color: var(--io-parchment-muted);
    font: 400 13px/1.2 var(--io-font-ui);
  }
  h2 {
    margin: 14px 0 0;
    color: var(--io-parchment);
    font: 700 28px/1.15 var(--io-font-display);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .lead {
    margin: 8px 0 0;
    color: var(--io-parchment-muted);
    font: 400 22px/1.4 var(--io-font-body);
  }

  /* On a phone the card fills the width and Onward is pinned to the bottom. */
  @media (max-width: 40rem) {
    .ov-backdrop {
      padding: 16px 16px 88px;
    }
    .rankup {
      width: 100%;
    }
    .card {
      padding: 28px 20px;
    }
    h2 {
      font-size: 28px;
    }
    .lead {
      font-size: 22px;
    }
    form {
      position: fixed;
      right: 16px;
      bottom: max(16px, env(safe-area-inset-bottom));
      left: 16px;
    }
    form :global(button) {
      width: 100%;
    }
  }
</style>
