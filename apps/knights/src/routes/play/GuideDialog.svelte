<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import RatingGuide from '$lib/RatingGuide.svelte';
  import { modal } from '$lib/modal';
  import '$lib/overlay.css';

  let {
    guide,
    first,
    message,
    submitting,
    submit,
  }: {
    guide: { level: number; label: string; description: string }[];
    /** The first-visit guide says so; a reopened one does not. */
    first: boolean;
    message: string | null;
    submitting: boolean;
    submit: SubmitFunction;
  } = $props();

  let form = $state<HTMLFormElement>();
  // Escape is the same answer as the button: the guide is read.
  const close = () => {
    if (!submitting) form?.requestSubmit();
  };
</script>

<div class="ov-backdrop">
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="guide-title"
    tabindex="-1"
    use:modal={{ onescape: close }}
  >
    <span class="handle" aria-hidden="true"></span>
    <div class="scroll">
      {#if first}<p class="ov-eyebrow">First visit</p>{/if}
      <h2 id="guide-title">The Rating Guide</h2>
      <p class="intro">What each level means. Rate what the image shows, not what you would like to see.</p>
      <div class="rule" aria-hidden="true"><span class="gem"></span></div>
      <RatingGuide {guide} />
    </div>
    <form class="footer" method="POST" action="?/dismissGuide" use:enhance={submit} bind:this={form}>
      {#if message}
        <p class="notice failed" role="alert">{message}</p>
      {:else if first}
        <p class="hint">Find this again any time under Rating guide.</p>
      {/if}
      <button type="submit" class="ov-primary" disabled={submitting} data-autofocus>I understand</button>
    </form>
  </div>
</div>

<style>
  .dialog {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 760px;
    max-height: 100%;
    border: 1px solid var(--io-gold);
    border-radius: 8px;
    background: var(--io-surface);
    overflow: hidden;
  }
  .scroll {
    flex: 1 1 auto;
    min-height: 0;
    padding: 32px 36px 8px;
    overflow-y: auto;
  }
  h2 {
    margin: 12px 0 0;
    color: var(--io-parchment);
    font: 700 36px/1.1 var(--io-font-display);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .intro {
    margin: 20px 0 0;
    color: var(--io-parchment-muted);
    font: 400 20px/1.4 var(--io-font-body);
  }
  .rule {
    display: flex;
    align-items: center;
    gap: 16px;
    margin: 20px 0 20px;
  }
  .rule::before,
  .rule::after {
    flex: 1;
    height: 1px;
    background: var(--io-gold-muted);
    content: '';
  }
  .gem {
    width: 8px;
    height: 8px;
    border: 1px solid var(--io-gold);
    transform: rotate(45deg);
  }
  .footer {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 20px 36px 28px;
    background: var(--io-surface);
  }
  .hint,
  .failed {
    margin: 0;
    color: var(--io-parchment-muted);
    font: 400 14px/1.4 var(--io-font-ui);
  }
  .failed {
    color: var(--io-crimson-text);
  }
  .handle {
    display: none;
  }

  /* On a phone the guide is a bottom sheet. */
  @media (max-width: 40rem) {
    .ov-backdrop {
      align-items: flex-end;
      padding: 0;
    }
    .dialog {
      max-width: none;
      max-height: 92dvh;
      border-width: 1px 0 0;
      border-radius: 20px 20px 0 0;
    }
    .handle {
      display: block;
      flex: none;
      width: 40px;
      height: 4px;
      margin: 12px auto 0;
      border-radius: 2px;
      background: var(--io-gold-muted);
    }
    .scroll {
      padding: 16px 20px 4px;
    }
    h2 {
      margin-top: 4px;
      font-size: 24px;
    }
    .intro {
      margin-top: 12px;
      font-size: 18px;
    }
    .rule {
      margin: 14px 0;
    }
    .footer {
      flex-direction: column-reverse;
      align-items: stretch;
      padding: 12px 20px max(20px, env(safe-area-inset-bottom));
    }
    .hint {
      display: none;
    }
    .footer :global(button) {
      width: 100%;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dialog {
      animation: none;
    }
  }
</style>
