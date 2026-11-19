<script lang="ts">
  import { count } from '$lib/format';
  import Icon from '$lib/Icon.svelte';
  import { page } from '$app/state';
  import { cardAction, membershipPerksUrl, tierName } from '$lib/shop-view';
  import type { PageData } from './$types';

  type Card = NonNullable<PageData['shop']>['cards'][number];

  let {
    card,
    balance,
    index = 99,
    shortBy = 0,
    refusal = null,
    shakeKey = 0,
    onbuy,
  }: {
    card: Card;
    balance: { convertible: number; held: boolean };
    index?: number;
    shortBy?: number;
    refusal?: string | null;
    shakeKey?: number;
    onbuy: (card: Card) => void;
  } = $props();

  const action = $derived(cardAction(card, balance));
  const title = $derived(`${tierName(card.tier)} week`);
  const blurb = $derived(
    card.description || `${tierName(card.tier)} perks on Civitai for a week. Perks only, no monthly Buzz.`
  );
</script>

<article
  class="tier"
  class:member={action.kind === 'member'}
  class:enter={index < 6}
  style:--i={index < 6 ? index : null}
  aria-labelledby="tier-{card.id}"
>
  <h3 id="tier-{card.id}">{title}</h3>
  <p class="blurb">{blurb}</p>
  <a
    class="perks"
    href={membershipPerksUrl(page.data.civitaiUrl)}
    target="_blank"
    rel="noopener noreferrer"
    aria-label="See what {title} includes on Civitai (opens in a new tab)">See perks</a
  >
  <div class="foot">
    <p class="price"><Icon name="coins" size={16} /><b>{count(card.price)}</b></p>
    {#if action.kind === 'buy' || action.kind === 'need'}
      {#key shakeKey}
        <button
          type="button"
          class="buy"
          class:quiet={action.kind === 'need'}
          class:shake={(shortBy > 0 || !!refusal) && shakeKey > 0}
          onclick={() => onbuy(card)}
          aria-label="Buy {title} for {count(card.price)} gold"
        >
          Buy
        </button>
      {/key}
    {:else}
      <span class="state">{action.label}</span>
    {/if}
  </div>
  {#if refusal}<p class="short" role="status">{refusal}</p>
  {:else if shortBy > 0}<p class="short" role="status">You need {count(shortBy)} more gold.</p>
  {:else if action.kind === 'need'}<p class="need">Need {count(action.by)} more</p>{/if}
</article>

<style>
  .tier {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    min-width: 0;
    padding: 1.25rem;
    border: 1px solid var(--io-gold-muted);
    border-radius: 6px;
    background: var(--io-surface);
  }
  .tier.enter {
    animation: mo-rise-in var(--motion-base) var(--ease-out-quart) both;
    animation-delay: calc(var(--i, 0) * 40ms);
  }
  .tier.member {
    border-color: var(--io-verdigris);
  }
  h3 {
    margin: 0;
    color: var(--io-parchment);
    font: 700 1.125rem/1.25 var(--io-font-display);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .blurb {
    margin: 0;
    color: var(--io-parchment-muted);
    font: 400 0.82rem/1.4 var(--io-font-ui);
  }
  .perks {
    align-self: flex-start;
    color: var(--io-gold);
    font: 500 0.75rem/1.6 var(--io-font-ui);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .perks:hover {
    color: var(--io-parchment);
  }
  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-top: auto;
  }
  .price {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0;
    color: var(--io-gold);
  }
  .price b {
    font: 700 1.15rem/1 var(--io-font-display);
    letter-spacing: 0.04em;
  }
  .buy {
    min-height: 2.75rem;
    padding: 0 1.25rem;
    border: 1px solid var(--io-gold);
    border-radius: 6px;
    background: var(--io-gold);
    color: var(--io-bg);
    font: 700 0.85rem/1 var(--io-font-display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    cursor: pointer;
  }
  .buy:hover {
    background: #d8b45a;
  }
  .buy:focus-visible {
    outline: 2px solid var(--io-parchment);
    outline-offset: 2px;
  }
  .buy.quiet {
    border-color: var(--io-gold-muted);
    background: transparent;
    color: var(--io-gold-muted);
  }
  .buy.shake {
    animation: tier-shake 240ms var(--ease-out-quart);
    background: transparent;
    border-color: var(--io-crimson);
    color: var(--io-crimson-text);
  }
  .state {
    color: var(--io-parchment-muted);
    font: 600 0.7rem/1.2 var(--io-font-ui);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .short,
  .need {
    margin: 0;
    font: 400 0.82rem/1.3 var(--io-font-ui);
  }
  .short {
    color: var(--io-crimson-text);
  }
  .need {
    color: var(--io-parchment-muted);
  }
  @keyframes tier-shake {
    25% {
      transform: translateX(-3px);
    }
    50% {
      transform: translateX(3px);
    }
    75% {
      transform: translateX(-3px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .tier.enter,
    .buy.shake {
      animation: none;
    }
  }
</style>
