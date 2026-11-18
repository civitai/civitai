<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { RULING_AUTO_HIDE_MS, autoHide } from '$lib/auto-hide';
  import { noticeTone } from '$lib/chrome';
  import '$lib/overlay.css';
  import type { PageData } from './$types';

  let {
    notices,
    message,
    submit,
    nudge = 0,
    anchored,
  }: {
    notices: PageData['notices'];
    /** Why the last dismissal failed, if it did. */
    message: string | null;
    submit: SubmitFunction;
    /** Bumped when the player tries to answer while the ruling holds the answers. */
    nudge?: number;
    /** Over the bottom of the image stage; otherwise in the page flow, where no stage is drawn. */
    anchored: boolean;
  } = $props();

  let tone = $derived(noticeTone(notices));
  let form = $state<HTMLFormElement>();
  let section = $state<HTMLElement>();

  // Restarts the pulse on every nudge (the class comes off, a reflow, then on again) and puts Enter back on Understood.
  $effect(() => {
    if (nudge === 0 || !section) return;
    section.querySelector<HTMLElement>('button[type="submit"]')?.focus({ preventScroll: true });
    section.classList.remove('nudged');
    void section.offsetWidth;
    section.classList.add('nudged');
  });
</script>

<!-- Understood is focused so Enter dismisses; left alone, it goes by the same form after RULING_AUTO_HIDE_MS. -->
<section
  class="toast"
  class:anchored
  class:calm={tone === 'calm'}
  role="status"
  aria-label="The Order's ruling"
  bind:this={section}
  use:autoHide={{
    ms: RULING_AUTO_HIDE_MS,
    onhide: () => form?.requestSubmit(),
    focus: 'button[type="submit"]',
    held: !!message,
  }}
>
  <div class="toast-body">
    {#each notices as notice (notice.key)}
      <div class="check-notice" class:close={notice.consequence === 'close'}>
        {#if notice.imageSrc}
          <img class="check-thumb" src={notice.imageSrc} alt="What you judged" loading="lazy" />
        {/if}
        <p>
          <strong>{notice.title}</strong>
          {notice.message}
          {#if notice.consequence === 'smite'}
            <span class="check-answers">
              You judged {notice.answerLabel}{#if notice.correctLabel}; the Order judged it {notice.correctLabel}{/if}.
            </span>
          {/if}
        </p>
      </div>
    {/each}
    {#if message}
      <p>{message}</p>
    {/if}
  </div>
  <form method="POST" action="?/dismissNotices" use:enhance={submit} bind:this={form}>
    <button type="submit">Understood</button>
  </form>
  <span class="countdown" aria-hidden="true"></span>
</section>

<style>
  .toast {
    position: relative;
    overflow: hidden;
    display: flex;
    align-items: center;
    gap: 12px;
    box-sizing: border-box;
    width: min(1000px, calc(100% - 32px));
    margin: 8px auto 0;
    padding: 8px 12px;
    border: 1px solid var(--io-crimson);
    border-radius: 12px;
    background: #14110d;
    color: var(--io-crimson-text);
    font: 400 13px/1.4 var(--io-font-ui);
  }
  /* Over the bottom of the image stage, as the level card floats over its top (z-index 4): the answer row stays clear. */
  .toast.anchored {
    position: absolute;
    bottom: 16px;
    left: 50%;
    z-index: 5;
    width: min(480px, calc(100% - 32px));
    margin: 0;
    transform: translateX(-50%);
    box-shadow: 0 12px 32px rgb(0 0 0 / 0.5);
    animation: ov-fade var(--motion-base) var(--ease-out-quart);
  }
  /* Close calls only: information, not an alarm. */
  .toast.calm {
    border-color: var(--io-gold);
    color: var(--io-gold);
  }
  /* A faint track for the time used; the bar on it drains over the auto-hide delay and stops while the timer waits. */
  .countdown {
    position: absolute;
    inset-inline: 0;
    bottom: 0;
    height: 4px;
    background: rgb(255 255 255 / 0.08);
  }
  .countdown::before {
    position: absolute;
    inset: 0;
    background: var(--io-crimson-text);
    content: '';
    transform-origin: left;
    animation: mo-countdown var(--auto-hide-ms) linear forwards;
    animation-play-state: var(--auto-hide-state);
  }
  .toast.calm .countdown::before {
    background: var(--io-gold);
  }
  /* A blocked answer: a short flash, within the play loop's 200ms (mo-smite-flash has its reduced-motion counterpart). */
  .toast:global(.nudged) {
    animation: mo-smite-flash 180ms var(--ease-out-quart);
  }
  .toast-body {
    flex: 1;
  }
  .toast-body p {
    margin: 0;
    color: var(--io-parchment);
  }
  .toast-body strong {
    color: var(--io-crimson-text);
  }
  .check-notice {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .check-notice + .check-notice {
    margin-top: 6px;
  }
  .check-notice.close strong {
    color: var(--io-gold);
  }
  .check-thumb {
    flex: none;
    width: 36px;
    height: 36px;
    border-radius: 6px;
    object-fit: cover;
  }
  .check-answers {
    color: var(--io-parchment);
    opacity: 0.8;
  }
  .toast button {
    min-height: 36px;
    padding: 8px 16px;
    border-color: var(--io-crimson);
    background: var(--io-crimson);
    color: var(--io-parchment);
    font-size: 13px;
  }
  @media (max-width: 40rem) {
    /* The stage's full width, its bottom edge on the stage's, just above the answer row. */
    .toast.anchored {
      bottom: 0;
      left: 0;
      width: 100%;
      transform: none;
    }
    .check-thumb {
      display: none;
    }
    .toast button {
      min-height: 44px;
    }
  }
</style>
