<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import { count } from '$lib/format';
  import Icon from '$lib/Icon.svelte';
  import { page } from '$app/state';
  import {
    cardBlurb,
    cardTitle,
    cosmeticIcon,
    dealPercentOff,
    membershipPerksUrl,
    packBonusPercent,
    packNote,
    refusalText
  } from '$lib/shop-view';
  import type { PageData } from './$types';

  type Card = NonNullable<PageData['shop']>['cards'][number];
  type IconName = ComponentProps<typeof Icon>['name'];

  let {
    card,
    variant,
    index = 99,
    shortBy = 0,
    refusal = null,
    shakeKey = 0,
    stamped = false,
    sheen = false,
    clock = '',
    onbuy,
  }: {
    card: Card;
    variant: 'deal' | 'pack' | 'row';
    /** Position in the grid: only the first few cards animate in. */
    index?: number;
    shortBy?: number;
    /** Why a click was refused before any request (a held purse), shown where the shortfall would be. */
    refusal?: string | null;
    shakeKey?: number;
    stamped?: boolean;
    sheen?: boolean;
    clock?: string;
    onbuy: (card: Card) => void;
  } = $props();

  const icon = $derived<IconName>(cosmeticIcon(card.kind, card.cosmeticType));
  const title = $derived(cardTitle(card));
  const note = $derived(cardBlurb(card));
  const pack = $derived(packNote(card));
  const bonus = $derived(
    card.kind === 'buzz_pack' ? packBonusPercent(card.buzz, card.listPrice, page.data.goldPerBuzz) : 0
  );

  const cta = $derived(
    card.state === 'owned'
      ? 'Owned'
      : card.state === 'member'
      ? 'You are a member'
      : card.state === 'rank'
      ? `Unlocks at ${card.minRank}`
      : card.state === 'sold-out'
      ? 'Gone for today'
      : card.state === 'closed'
      ? 'Not available now'
      : `Buy · ${count(card.price)} gold`
  );
  const buyable = $derived(card.state === 'available');
</script>

<article
  class="card {variant}"
  class:deal={card.deal}
  class:gated={card.state === 'rank'}
  class:gone={card.state === 'sold-out' || card.state === 'closed'}
  class:owned={card.state === 'owned'}
  style:--i={index < 6 ? index : null}
  class:enter={index < 6}
  aria-labelledby="card-{card.id}"
>
  {#if sheen && card.deal && card.state === 'available'}<span class="sheen" aria-hidden="true"></span>{/if}
  <div class="art" aria-hidden="true">
    {#if card.image && variant === 'row'}
      <img src={card.image} alt="" loading="lazy" />
    {:else}
      <Icon name={icon} size={variant === 'deal' ? 26 : 22} />
    {/if}
  </div>
  <div class="body">
    {#if variant === 'pack'}
      <p class="pack-amount"><span id="card-{card.id}">{count(card.buzz ?? 0)}</span> <span class="unit">Buzz</span></p>
    {:else}
      <h3 id="card-{card.id}">{title}</h3>
    {/if}
    {#if variant !== 'pack'}<p class="note">{note}</p>{/if}
    {#if card.kind === 'membership'}
      <a
        class="perks"
        href={membershipPerksUrl(page.data.civitaiUrl)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="See what {title} includes on Civitai (opens in a new tab)"
      >See perks</a>
    {/if}
    <p class="price">
      <Icon name="coins" size={16} /><b>{count(card.price)}</b>
      {#if card.deal}<s>{count(card.listPrice)}</s>{/if}
      {#if pack}<span class="per">&nbsp;· {pack}</span>{/if}
      {#if variant === 'pack' && bonus > 0}<span class="chip">+{bonus}% more Buzz</span>{/if}
    </p>
    <!-- A closed pack shelf says so once, above the packs. -->
    {#if card.state === 'closed' && variant !== 'pack'}<p class="why">{refusalText('closed')}</p>{/if}
  </div>
  {#if card.deal}
    <span class="tag">{card.state === 'rank' ? `${card.minRank} only` : `-${dealPercentOff(card.price, card.listPrice)}% today`}</span>
    {#if clock && card.state === 'available'}<span class="ends" aria-label="Deal ends in {clock}">Ends in {clock}</span>{/if}
  {:else if card.state === 'rank' && variant !== 'pack'}
    <span class="tag quiet"><Icon name="lock" size={12} />{card.minRank}+</span>
  {/if}

  {#if variant === 'deal'}
    {#key shakeKey}
      <button
        type="button"
        class="buy"
        class:shake={(shortBy > 0 || !!refusal) && shakeKey > 0}
        class:muted={!buyable}
        aria-disabled={!buyable}
        onclick={() => buyable && onbuy(card)}
      >
        {cta}
      </button>
    {/key}
  {:else if card.state === 'owned'}
    <span class="seal" class:stamp={stamped}>Owned</span>
  {:else if card.state === 'available'}
    {#key shakeKey}
      <button
        type="button"
        class="buy small"
        class:shake={(shortBy > 0 || !!refusal) && shakeKey > 0}
        onclick={() => onbuy(card)}
        aria-label="Buy {title} for {count(card.price)} gold"
      >
        Buy
      </button>
    {/key}
  {:else if !(variant === 'pack' && card.state === 'closed')}
    <span class="state">{cta}</span>
  {/if}
  {#if refusal}<p class="short" role="status">{refusal}</p>
  {:else if shortBy > 0}<p class="short" role="status">You need {count(shortBy)} more gold.</p>{/if}
  {#if stamped && variant === 'deal'}<span class="seal stamp over">Owned</span>{/if}
</article>

<style>
  .card {
    position: relative;
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 0.75rem 1rem;
    padding: 1rem 1.1rem;
    overflow: hidden;
    border: 1px solid var(--io-gold-muted);
    border-radius: 8px;
    background: var(--io-surface);
    transition: border-color var(--motion-base) var(--ease-out-quart);
  }
  .card.enter {
    animation: mo-rise-in var(--motion-base) var(--ease-out-quart) both;
    animation-delay: calc(var(--i, 0) * 40ms);
  }
  .card.deal {
    border: 1.5px solid var(--io-gold);
  }
  .card.gated,
  .card.gone {
    border-color: var(--io-gold-muted);
  }
  .card.owned {
    border-color: var(--io-verdigris);
  }
  .art {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    overflow: hidden;
    border: 1px solid var(--io-gold-muted);
    border-radius: 8px;
    background: var(--io-matte);
    color: var(--io-gold);
  }
  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .body {
    min-width: 0;
  }
  h3,
  .pack-amount {
    margin: 0;
    color: var(--io-parchment);
    font: 700 1.05rem/1.25 var(--io-font-display);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .pack-amount {
    font-size: 1.7rem;
    text-transform: none;
  }
  .unit {
    color: var(--io-parchment-muted);
    font: 600 0.7rem/1 var(--io-font-ui);
    letter-spacing: 0.2em;
    text-transform: uppercase;
  }
  .chip {
    margin-left: auto;
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--io-gold-muted);
    border-radius: 3px;
    color: var(--io-gold);
    font: 600 0.62rem/1.2 var(--io-font-ui);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .perks {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    color: var(--io-gold);
    font: 500 12px/1.4 var(--io-font-ui);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .perks:hover {
    color: var(--io-parchment);
  }
  .note {
    margin: 0.25rem 0 0;
    color: var(--io-parchment-muted);
    font: 400 0.82rem/1.4 var(--io-font-ui);
  }
  .price {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0.4rem 0 0;
    color: var(--io-gold);
  }
  .price b {
    font: 700 1.15rem/1 var(--io-font-display);
  }
  .price .per,
  .why {
    color: var(--io-parchment-muted);
    font: 400 0.82rem/1.4 var(--io-font-ui);
    text-transform: none;
  }
  .why {
    margin: 0.35rem 0 0;
  }
  .price s {
    color: var(--io-parchment-muted);
    font: 400 0.85rem/1 var(--io-font-ui);
  }
  .tag {
    position: absolute;
    top: 0.9rem;
    right: 1rem;
    padding: 0.2rem 0.5rem;
    border-radius: 3px;
    background: var(--io-gold);
    color: var(--io-bg);
    font: 700 0.65rem/1.2 var(--io-font-ui);
    letter-spacing: 0.15em;
    text-transform: uppercase;
  }
  .tag.quiet {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: transparent;
    color: var(--io-parchment-muted);
  }
  .ends {
    position: absolute;
    top: 2.4rem;
    right: 1rem;
    color: var(--io-gold);
    font: 700 0.65rem/1 var(--io-font-ui);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .buy {
    min-height: 44px;
    padding: 0 1.25rem;
    border: 0;
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
  .buy.muted {
    border: 1px solid var(--io-gold);
    background: transparent;
    color: var(--io-gold);
    cursor: default;
  }
  .buy.shake {
    animation: shop-shake 240ms var(--ease-out-quart);
    background: transparent;
    border: 1px solid var(--io-crimson);
    color: var(--io-crimson-text);
  }
  .state {
    color: var(--io-parchment-muted);
    font: 600 0.7rem/1.2 var(--io-font-ui);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .seal {
    padding: 0.3rem 0.6rem;
    border-radius: 3px;
    background: var(--io-verdigris);
    color: var(--io-bg);
    font: 700 0.65rem/1.2 var(--io-font-ui);
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }
  .seal.stamp {
    animation: mo-stamp var(--motion-milestone-min) var(--ease-stamp) 120ms both;
  }
  .seal.over {
    position: absolute;
    right: 1.1rem;
    bottom: 1.1rem;
  }
  .short {
    grid-column: 1 / -1;
    margin: 0;
    color: var(--io-crimson-text);
    font: 400 0.82rem/1.3 var(--io-font-ui);
    animation: mo-fade-in var(--motion-base) var(--ease-out-quart);
  }
  .sheen {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: linear-gradient(105deg, transparent 35%, rgb(232 220 192 / 0.22) 50%, transparent 65%);
    animation: shop-sheen 9200ms var(--ease-in-out) 600ms infinite;
  }

  /* The big deal card stacks: art and badge on top, copy, then a full-width button. */
  .deal {
    grid-template-columns: 1fr;
    align-items: start;
    gap: 0.9rem;
    padding: 1.4rem;
  }
  .deal .art {
    width: 56px;
    height: 56px;
    border-radius: 50%;
  }
  .deal h3 {
    font-size: 1.25rem;
  }
  .deal .buy {
    width: 100%;
  }

  /* A pack is a compact tile. */
  .pack {
    grid-template-columns: 1fr;
    gap: 0.5rem;
    align-items: start;
  }
  .pack .art {
    display: none;
  }
  .pack .buy.small {
    justify-self: start;
  }

  @keyframes shop-shake {
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
  @keyframes shop-sheen {
    0% {
      opacity: 0;
      transform: translateX(-100%);
    }
    4% {
      opacity: 1;
    }
    13%,
    100% {
      opacity: 0;
      transform: translateX(100%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sheen {
      display: none;
    }
    .card.enter,
    .seal.stamp,
    .short,
    .buy.shake {
      animation: none;
    }
  }
  @media (max-width: 47.99rem) {
    .card:not(.deal):not(.pack) {
      grid-template-columns: auto 1fr;
    }
    .card:not(.deal):not(.pack) .buy.small,
    .card:not(.deal):not(.pack) .seal,
    .card:not(.deal):not(.pack) .state {
      grid-column: 1 / -1;
      justify-self: stretch;
      text-align: center;
    }
  }
  .buy:focus-visible {
    outline: 2px solid var(--io-parchment);
    outline-offset: 2px;
  }
</style>
