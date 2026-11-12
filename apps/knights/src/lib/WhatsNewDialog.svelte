<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { modal } from '$lib/modal';
  import {
    ANNOUNCEMENT_URL,
    WHATS_NEW_LEAD,
    WHATS_NEW_TITLE,
    type WhatsNewItem,
  } from '$lib/whats-new';
  import './overlay.css';

  let {
    items,
    message,
    submitting,
    submit,
  }: {
    items: WhatsNewItem[];
    message: string | null;
    submitting: boolean;
    submit: SubmitFunction;
  } = $props();

  let form = $state<HTMLFormElement>();
  // Escape and a click outside are the same answer as the button: it has been read.
  const close = () => {
    if (!submitting) form?.requestSubmit();
  };
</script>

<div
  class="ov-backdrop"
  role="presentation"
  onclick={(event) => event.target === event.currentTarget && close()}
>
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="whats-new-title"
    tabindex="-1"
    use:modal={{ onescape: close }}
  >
    <span class="handle" aria-hidden="true"></span>
    <div class="scroll">
      <p class="ov-eyebrow">What's new</p>
      <h2 id="whats-new-title">{WHATS_NEW_TITLE}</h2>
      <p class="intro">{WHATS_NEW_LEAD}</p>
      <div class="rule" aria-hidden="true"><span class="gem"></span></div>
      <ul>
        {#each items as item (item.lead)}
          <li>
            <span class="mark" aria-hidden="true"></span>
            <p>
              <strong>
                {#if item.link}
                  {@const [before, after] = item.lead.split(item.link.text)}
                  {before}<a href={item.link.href}>{item.link.text}</a>{after}
                {:else}
                  {item.lead}
                {/if}
              </strong>
              {item.body}
            </p>
          </li>
        {/each}
      </ul>
    </div>
    <form class="footer" method="POST" action="?/dismissWhatsNew" use:enhance={submit} bind:this={form}>
      {#if message}
        <p class="failed" role="alert">{message}</p>
      {:else if ANNOUNCEMENT_URL}
        <a class="announcement" href={ANNOUNCEMENT_URL} target="_blank" rel="noopener">Read the announcement</a>
      {/if}
      <button type="submit" class="ov-primary" disabled={submitting} data-autofocus>Start judging</button>
    </form>
  </div>
</div>

<style>
  .dialog {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 640px;
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
    font: 700 32px/1.15 var(--io-font-display);
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
    margin: 20px 0;
  }
  .rule::before,
  .rule::after {
    flex: 1;
    height: 1px;
    background: var(--io-gold-muted);
    content: '';
  }
  .gem,
  .mark {
    width: 8px;
    height: 8px;
    border: 1px solid var(--io-gold);
    transform: rotate(45deg);
  }
  ul {
    display: flex;
    flex-direction: column;
    gap: 16px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    align-items: baseline;
    gap: 14px;
  }
  .mark {
    flex: none;
    translate: 0 -2px;
  }
  li p {
    margin: 0;
    color: var(--io-parchment-muted);
    font: 400 17px/1.5 var(--io-font-body);
  }
  strong {
    color: var(--io-parchment);
    font-weight: 700;
  }
  a {
    color: var(--io-gold);
    text-decoration: underline;
    text-underline-offset: 3px;
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
  .footer button {
    margin-left: auto;
  }
  .announcement {
    font: 600 14px/1.4 var(--io-font-ui);
  }
  .failed {
    margin: 0;
    color: var(--io-crimson-text);
    font: 400 14px/1.4 var(--io-font-ui);
  }
  .handle {
    display: none;
  }

  /* On a phone the dialog is a bottom sheet, as the rating guide is. */
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
    li p {
      font-size: 16px;
    }
    .footer {
      flex-direction: column-reverse;
      align-items: stretch;
      padding: 12px 20px max(20px, env(safe-area-inset-bottom));
      text-align: center;
    }
    .footer :global(button) {
      width: 100%;
    }
  }
</style>
