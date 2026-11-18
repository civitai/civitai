<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import Icon from '$lib/Icon.svelte';
  import { noticeTone } from '$lib/chrome';
  import type { PageData } from './$types';

  let {
    notices,
    message,
    submitting,
    submit,
  }: {
    notices: PageData['notices'];
    /** Why the last dismissal failed, if it did. */
    message: string | null;
    submitting: boolean;
    submit: SubmitFunction;
  } = $props();

  let tone = $derived(noticeTone(notices));
</script>

<section class="toast" class:calm={tone === 'calm'} role="status" aria-label="The Order's ruling">
  <Icon name={tone === 'calm' ? 'info' : 'triangle-alert'} size={18} />
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
  <form method="POST" action="?/dismissNotices" use:enhance={submit}>
    <button type="submit" disabled={submitting}>Understood</button>
  </form>
</section>

<style>
  .toast {
    display: flex;
    flex: none;
    align-items: center;
    gap: 12px;
    box-sizing: border-box;
    width: 100%;
    padding: 12px 16px;
    border: 1px solid var(--io-crimson);
    border-radius: 12px;
    background: #14110dee;
    color: var(--io-crimson-text);
    font: 400 13px/1.4 var(--io-font-ui);
  }
  /* Close calls only: information, not an alarm. */
  .toast.calm {
    border-color: var(--io-gold);
    color: var(--io-gold);
  }
  .toast-body {
    flex: 1;
  }
  .toast-body p {
    margin: 0;
    color: var(--io-parchment);
  }
  .toast-body strong {
    display: block;
    color: var(--io-crimson-text);
  }
  .check-notice {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .check-notice + .check-notice {
    margin-top: 8px;
  }
  .check-notice.close strong {
    color: var(--io-gold);
  }
  .check-thumb {
    flex: none;
    width: 48px;
    height: 48px;
    border-radius: 6px;
    object-fit: cover;
  }
  .check-answers {
    display: block;
    color: var(--io-parchment);
    opacity: 0.8;
  }
  .toast button {
    min-height: 0;
    padding: 6px 12px;
    border-color: var(--io-crimson);
    font-size: 12px;
  }
  @media (max-width: 40rem) {
    /* Text takes the full width and Understood drops to its own line; the title's own glyph stands in for the icon. */
    .toast {
      flex-wrap: wrap;
      align-items: flex-start;
      gap: 8px;
      padding: 10px 12px;
    }
    .toast > :global(svg) {
      display: none;
    }
    .toast form {
      display: flex;
      flex-basis: 100%;
      justify-content: flex-end;
    }
    .check-thumb {
      width: 36px;
      height: 36px;
    }
  }
</style>
