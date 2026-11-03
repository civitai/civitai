<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { count } from '$lib/format';
  import '$lib/overlay.css';

  let {
    level,
    xpToNext,
    message,
    submitting,
    submit,
    floating = true,
    milestone = null,
  }: {
    level: number;
    /** XP still needed for the next level, when it is known for this level. */
    xpToNext: number | null;
    message: string | null;
    submitting: boolean;
    submit: SubmitFunction;
    /** Over the top of the image stage; otherwise it sits in the page flow. */
    floating?: boolean;
    /** Words for a milestone level; replaces the plain level-up line. */
    milestone?: string | null;
  } = $props();
</script>

<section class="toast" class:floating role="status" aria-label="Level up">
  <span class="ov-crest crest">{level}</span>
  <div class="body">
    <p class="ov-eyebrow">{milestone ? 'Milestone' : 'Level up'}</p>
    <p class="heading">{milestone ?? `You have reached level ${level}`}</p>
    {#if xpToNext !== null}<p class="sub">{count(xpToNext)} XP to level {level + 1}</p>{/if}
    {#if message}<p class="notice" role="alert">{message}</p>{/if}
  </div>
  <form method="POST" action="?/dismissProgress" use:enhance={submit}>
    <button type="submit" class="dismiss" disabled={submitting}>Onward</button>
  </form>
</section>

<style>
  .toast {
    display: flex;
    align-items: center;
    gap: 16px;
    width: min(500px, 100%);
    padding: 16px 20px;
    border: 1px solid var(--io-gold);
    border-radius: 8px;
    background: linear-gradient(180deg, #3a2c10, var(--io-surface));
    box-shadow: 0 12px 32px rgb(0 0 0 / 0.5);
    animation: ov-fade var(--motion-base) var(--ease-out-quart);
  }
  /* Over the top of the stage: the question line above it and the answer pills below it stay clear. */
  .toast.floating {
    position: absolute;
    top: 16px;
    left: 50%;
    z-index: 4;
    width: min(500px, calc(100% - 32px));
    transform: translateX(-50%);
  }
  .toast:not(.floating) {
    margin: 8px auto;
  }
  .crest {
    width: 52px;
    height: 52px;
    font: 700 22px/1 var(--io-font-display);
    color: var(--io-gold);
  }
  .body {
    flex: 1;
    min-width: 0;
  }
  .body p {
    margin: 0;
  }
  .heading {
    margin-top: 2px;
    color: var(--io-parchment);
    font: 700 16px/1.2 var(--io-font-display);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .sub {
    margin-top: 2px;
    color: var(--io-parchment-muted);
    font: 400 16px/1.3 var(--io-font-body);
  }
  .dismiss {
    min-height: 0;
    padding: 6px 10px;
    border-color: var(--io-gold-muted);
    background: transparent;
    color: var(--io-gold);
    font: 600 12px/1.2 var(--io-font-ui);
  }

  @media (max-width: 40rem) {
    .toast.floating {
      top: 0;
      left: 0;
      width: 100%;
      transform: none;
    }
    .toast {
      gap: 12px;
      padding: 12px 14px;
    }
    .crest {
      width: 44px;
      height: 44px;
      font-size: 18px;
    }
    .heading {
      font-size: 14px;
    }
    .dismiss {
      min-height: 36px;
    }
  }
</style>
