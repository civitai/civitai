<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import OverlayIcon from '$lib/OverlayIcon.svelte';
  import '$lib/overlay.css';

  let {
    smites,
    message,
    submitting,
    submit,
  }: { smites: number; message: string | null; submitting: boolean; submit: SubmitFunction } = $props();
</script>

<section class="reset" role="status" aria-labelledby="reset-title">
  <div class="mark">
    <span class="ov-crest crest"><OverlayIcon name="flame" size={44} /></span>
    <p class="rank">Acolyte</p>
    <p class="where">The Apprenticeship</p>
  </div>
  <div class="text">
    <p class="ov-eyebrow crimson">Career reset</p>
    <h1 id="reset-title">Your career has been reset.</h1>
    <p class="lead">
      {smites} smites were more than the Order would bear. You are an Acolyte again at level 1, and your apprenticeship begins again.
    </p>
    {#if message}
      <p class="notice" role="alert">{message}</p>
    {/if}
    <form method="POST" action="?/dismissResetNotice" use:enhance={submit}>
      <button type="submit" class="ov-primary" disabled={submitting}>Understood</button>
    </form>
  </div>
</section>

<style>
  .reset {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    justify-content: center;
    gap: 64px;
    width: 100%;
    max-width: 1056px;
    min-height: 0;
    margin: 0 auto;
    padding: 24px 28px;
    animation: ov-fade var(--motion-base) var(--ease-out-quart);
  }
  .mark {
    display: flex;
    flex: none;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .crest {
    width: 90px;
    height: 90px;
  }
  .rank {
    margin: 8px 0 0;
    color: var(--io-parchment);
    font: 700 18px/1.2 var(--io-font-display);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .where {
    margin: 0;
    color: var(--io-parchment-muted);
    font: 400 13px/1.2 var(--io-font-ui);
  }
  .text {
    display: flex;
    flex: 0 1 560px;
    flex-direction: column;
    align-items: flex-start;
    gap: 14px;
  }
  h1 {
    margin: 0;
    color: var(--io-parchment);
    font: 700 40px/1.1 var(--io-font-display);
    letter-spacing: 0.04em;
  }
  .lead {
    margin: 0;
    color: var(--io-parchment);
    font: 400 22px/1.45 var(--io-font-body);
  }
  form {
    margin-top: 8px;
  }

  @media (max-width: 40rem) {
    .reset {
      flex-direction: column;
      justify-content: center;
      gap: 20px;
      padding: 20px 16px max(16px, env(safe-area-inset-bottom));
    }
    .crest {
      width: 72px;
      height: 72px;
    }
    .text {
      flex: none;
      align-items: center;
      width: 100%;
      text-align: center;
    }
    h1 {
      font-size: 28px;
    }
    .lead {
      font-size: 20px;
    }
    form,
    form :global(button) {
      width: 100%;
    }
  }
</style>
