<script lang="ts">
  import { untrack, type ComponentProps } from 'svelte';
  import { applyAction, enhance } from '$app/forms';
  import { count } from '$lib/format';
  import Icon from '$lib/Icon.svelte';
  import { modal } from '$lib/modal';
  import { cardBlurb, cardTitle, cosmeticIcon, packNote } from '$lib/shop-view';
  import '$lib/overlay.css';
  import type { PageData } from './$types';

  type Card = NonNullable<PageData['shop']>['cards'][number];

  let {
    card,
    spendable,
    requestKey,
    onclose,
    onbought,
  }: {
    card: Card;
    spendable: number;
    requestKey: string;
    onclose: () => void;
    /** Fires only once the server has confirmed. */
    onbought: (card: Card, pending: boolean) => void;
  } = $props();

  // A refused purchase replays its answer for the same key, so a fresh try needs a fresh key.
  let key = $state(untrack(() => requestKey));
  let submitting = $state(false);
  let problem = $state<string | null>(null);
  let closing = $state(false);

  const icon = $derived<ComponentProps<typeof Icon>['name']>(cosmeticIcon(card.kind, card.cosmeticType));
  const title = $derived(cardTitle(card));
  const blurb = $derived(cardBlurb(card));
  const delivered = $derived(card.kind !== 'cosmetic');
  const cancel = () => {
    if (!submitting) onclose();
  };
</script>

<div class="ov-backdrop" class:closing>
  <div
    class="dialog"
    class:closing
    role="dialog"
    aria-modal="true"
    aria-labelledby="buy-title"
    tabindex="-1"
    use:modal={{ onescape: cancel }}
  >
    <p class="ov-eyebrow">Confirm purchase</p>
    <span class="ov-crest crest"><Icon name={icon} size={36} /></span>
    <h2 id="buy-title">{title}</h2>
    <p class="blurb">{blurb}</p>

    <dl>
      <div><dt>Price</dt><dd class="gold"><Icon name="coins" size={16} />{count(card.price)}{#if packNote(card)}<span class="per">&nbsp;· {packNote(card)}</span>{/if}</dd></div>
      <div><dt>Your gold</dt><dd><Icon name="coins" size={16} />{count(spendable)}</dd></div>
      <div><dt>After purchase</dt><dd><Icon name="coins" size={16} />{count(Math.max(0, spendable - card.price))}</dd></div>
    </dl>

    <form
      method="POST"
      action="?/buy"
      use:enhance={() => {
        submitting = true;
        problem = null;
        return async ({ result, update }) => {
          try {
            if (result.type === 'success' && result.data?.ok) {
              // The server has confirmed; only now does the dialog leave and the purse count down.
              closing = true;
              await update({ reset: false });
              onbought(card, Boolean(result.data.pending));
              return;
            }
            if (result.type === 'failure') {
              problem = String(result.data?.message ?? 'That purchase did not go through.');
              key = crypto.randomUUID();
              return;
            }
            if (result.type === 'redirect' || result.type === 'error') {
              await applyAction(result);
              return;
            }
            problem = 'That purchase did not go through. Try again.';
            key = crypto.randomUUID();
          } finally {
            submitting = false;
          }
        };
      }}
    >
      <input type="hidden" name="itemId" value={card.id} />
      <input type="hidden" name="price" value={card.price} />
      <input type="hidden" name="requestKey" value={key} />
      <button type="submit" class="ov-primary buy" disabled={submitting} data-autofocus class:working={submitting}>
        {submitting ? 'Buying…' : `Buy for ${count(card.price)} gold`}
      </button>
      <button type="button" class="ov-secondary" disabled={submitting} onclick={cancel}>Not now</button>
    </form>

    {#if problem}<p class="problem" role="alert">{problem}</p>{/if}
    {#if delivered}
      <p class="fine">
        If Civitai can't confirm it right away, your gold stays reserved and we retry automatically. You are never charged twice.
      </p>
    {/if}
  </div>
</div>

<style>
  .dialog {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.9rem;
    width: min(26rem, 100%);
    max-height: 100%;
    padding: 2rem 1.75rem;
    overflow-y: auto;
    border: 1.5px solid var(--io-gold);
    border-radius: 8px;
    background: var(--io-surface);
    text-align: center;
    transition:
      opacity var(--motion-base) var(--ease-out-quart),
      transform var(--motion-base) var(--ease-out-quart);
  }
  @media (prefers-reduced-motion: reduce) {
    .dialog,
    .ov-backdrop.closing {
      transition: none;
    }
  }
  .dialog.closing {
    opacity: 0;
    transform: scale(0.98);
  }
  .ov-backdrop.closing {
    transition: opacity var(--motion-base) var(--ease-out-quart);
    opacity: 0;
  }
  .crest {
    width: 88px;
    height: 88px;
  }
  h2 {
    margin: 0;
    color: var(--io-parchment);
    font: 700 1.5rem/1.2 var(--io-font-display);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .blurb {
    margin: 0;
    color: var(--io-parchment-muted);
    font: 400 0.95rem/1.45 var(--io-font-ui);
  }
  dl {
    width: 100%;
    margin: 0.5rem 0;
  }
  dl > div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 0;
    border-bottom: 1px solid var(--io-gold-muted);
  }
  dl > div:last-child {
    border-bottom: 0;
  }
  dt {
    color: var(--io-parchment-muted);
    font: 400 0.9rem/1 var(--io-font-ui);
  }
  dd {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0;
    color: var(--io-parchment);
    font: 700 1.1rem/1 var(--io-font-display);
  }
  dd.gold {
    color: var(--io-gold);
  }
  dd .per {
    color: var(--io-parchment-muted);
    font: 400 0.85rem/1 var(--io-font-ui);
    text-transform: none;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    width: 100%;
  }
  .buy.working {
    outline: 2px solid var(--io-gold);
    outline-offset: 2px;
    transition: outline-offset var(--motion-fast) var(--ease-out-quart);
  }
  .fine,
  .problem {
    margin: 0;
    font: 400 0.78rem/1.4 var(--io-font-ui);
  }
  .fine {
    color: var(--io-parchment-muted);
  }
  .problem {
    color: var(--io-crimson-text);
    font-size: 0.9rem;
    font-weight: 600;
  }
</style>
