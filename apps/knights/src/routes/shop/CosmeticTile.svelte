<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import { count } from '$lib/format';
  import Icon from '$lib/Icon.svelte';
  import {
    cardAction,
    cosmeticIcon,
    dealPercentOff,
    nameplateBackground,
    packNote,
    plateScale,
    tileName,
  } from '$lib/shop-view';
  import type { PageData } from './$types';

  type Card = NonNullable<PageData['shop']>['cards'][number];

  let {
    card,
    username,
    balance,
    index = 99,
    shortBy = 0,
    refusal = null,
    shakeKey = 0,
    stamped = false,
    onbuy,
    ontry,
  }: {
    card: Card;
    /** The viewer's name, painted in a nameplate's gradient. */
    username: string;
    balance: { convertible: number; held: boolean };
    /** Position in the shop: only the first few cards animate in. */
    index?: number;
    shortBy?: number;
    refusal?: string | null;
    shakeKey?: number;
    stamped?: boolean;
    onbuy: (card: Card) => void;
    ontry: (card: Card) => void;
  } = $props();

  const icon = $derived<ComponentProps<typeof Icon>['name']>(cosmeticIcon(card.kind, card.cosmeticType));
  const action = $derived(cardAction(card, balance));
  const name = $derived(tileName(card.name));
  const pack = $derived(packNote(card));
</script>

<article
  class="tile"
  class:gated={action.kind === 'locked'}
  class:deal={card.deal}
  class:owned={action.kind === 'owned'}
  class:enter={index < 6}
  style:--i={index < 6 ? index : null}
  aria-labelledby="tile-{card.id}"
>
  <button type="button" class="preview" onclick={() => ontry(card)} aria-label="Try on {card.name}">
    <span class="art" class:dim={action.kind === 'locked'}>
      {#if card.nameplate}
        <span
          class="plate"
          style:background-image={nameplateBackground(card.nameplate)}
          style:--plate-scale={plateScale(username)}>{username}</span
        >
      {:else if card.image}
        <img src={card.image} alt="" loading="lazy" />
      {:else}
        <Icon name={icon} size={40} />
      {/if}
    </span>
    {#if card.deal}<span class="tag">-{dealPercentOff(card.price, card.listPrice)}% today</span>{/if}
  </button>
  <h4 id="tile-{card.id}">{name}</h4>
  <p class="price">
    <Icon name="coins" size={15} /><b>{count(card.price)}</b>
    {#if card.deal}<s>{count(card.listPrice)}</s>{/if}
    {#if pack}<span class="per">&nbsp;· {pack}</span>{/if}
  </p>
  <div class="foot">
    <button type="button" class="try" onclick={() => ontry(card)} aria-label="Try on {card.name}">
      <Icon name="eye" size={14} />Try on
    </button>
    {#if action.kind === 'locked'}
      <span class="lock"><Icon name="lock" size={12} />{card.minRank}+</span>
    {:else if action.kind === 'owned'}
      <span class="seal" class:stamp={stamped}>Owned</span>
    {:else if action.kind === 'buy' || action.kind === 'need'}
      {#key shakeKey}
        <button
          type="button"
          class="buy"
          class:quiet={action.kind === 'need'}
          class:shake={(shortBy > 0 || !!refusal) && shakeKey > 0}
          onclick={() => onbuy(card)}
          aria-label="Buy {card.name} for {count(card.price)} gold"
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
  .tile {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    min-width: 0;
    padding: 0.875rem;
    border: 1px solid var(--io-gold-muted);
    border-radius: 6px;
    background: var(--io-surface);
    transition: border-color var(--motion-base) var(--ease-out-quart);
  }
  .tile.enter {
    animation: mo-rise-in var(--motion-base) var(--ease-out-quart) both;
    animation-delay: calc(var(--i, 0) * 40ms);
  }
  .tile:hover {
    border-color: var(--io-gold);
  }
  .tile.gated {
    border-color: var(--io-matte);
  }
  .tile.owned {
    border-color: var(--io-verdigris);
  }
  .tile.deal {
    border: 1.5px solid var(--io-gold);
  }
  .preview {
    position: relative;
    display: block;
    width: 100%;
    padding: 0;
    border: 0;
    background: none;
    cursor: pointer;
  }
  .preview:focus-visible,
  .try:focus-visible,
  .buy:focus-visible {
    outline: 2px solid var(--io-parchment);
    outline-offset: 2px;
  }
  .art {
    display: grid;
    place-items: center;
    height: 8.25rem;
    overflow: hidden;
    border-radius: 4px;
    background: var(--io-matte);
    color: var(--io-gold);
  }
  .art.dim {
    opacity: 0.55;
  }
  .art img {
    width: 100%;
    height: 100%;
    padding: 0.75rem;
    object-fit: contain;
  }
  /* Never cut: a long name is drawn smaller (`plateScale`) and, at the floor, may wrap. */
  .plate {
    max-width: 100%;
    padding: 0 0.5rem;
    background-clip: text;
    -webkit-background-clip: text;
    color: transparent;
    font: 700 calc(1.5rem * var(--plate-scale, 1)) / 1.2 var(--io-font-display);
    overflow-wrap: anywhere;
    text-align: center;
  }
  .tag {
    position: absolute;
    top: 0.5rem;
    left: 0.5rem;
    padding: 0.2rem 0.5rem;
    border-radius: 3px;
    background: var(--io-gold);
    color: var(--io-bg);
    font: 700 0.65rem/1.2 var(--io-font-ui);
    letter-spacing: 0.15em;
    text-transform: uppercase;
  }
  h4 {
    margin: 0;
    color: var(--io-parchment);
    font: 700 0.95rem/1.25 var(--io-font-display);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .price {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35rem;
    margin: 0;
    color: var(--io-gold);
  }
  .price b {
    font: 700 1.1rem/1 var(--io-font-display);
    letter-spacing: 0.04em;
  }
  .price s,
  .price .per {
    color: var(--io-parchment-muted);
    font: 400 0.8rem/1.2 var(--io-font-ui);
    text-transform: none;
  }
  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-top: auto;
  }
  .try {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    min-height: 2.25rem;
    padding: 0 0.25rem;
    border: 0;
    background: none;
    color: var(--io-gold-muted);
    font: 600 0.75rem/1.2 var(--io-font-ui);
    cursor: pointer;
  }
  .try:hover {
    color: var(--io-gold);
  }
  .lock,
  .state {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    color: var(--io-parchment-muted);
    font: 600 0.65rem/1.2 var(--io-font-ui);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .buy {
    min-height: 2.25rem;
    padding: 0 1rem;
    border: 1px solid var(--io-gold);
    border-radius: 6px;
    background: var(--io-gold);
    color: var(--io-bg);
    font: 700 0.8rem/1 var(--io-font-display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    cursor: pointer;
  }
  .buy:hover {
    background: #d8b45a;
  }
  /* Not enough gold yet: the button stays (its click explains the gap) but steps back. */
  .buy.quiet {
    border-color: var(--io-gold-muted);
    background: transparent;
    color: var(--io-gold-muted);
  }
  .buy.quiet:hover {
    color: var(--io-gold);
  }
  .buy.shake {
    animation: tile-shake 240ms var(--ease-out-quart);
    background: transparent;
    border-color: var(--io-crimson);
    color: var(--io-crimson-text);
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
  .short,
  .need {
    margin: 0;
    font: 400 0.8rem/1.3 var(--io-font-ui);
  }
  .short {
    color: var(--io-crimson-text);
    animation: mo-fade-in var(--motion-base) var(--ease-out-quart);
  }
  .need {
    color: var(--io-parchment-muted);
  }
  @keyframes tile-shake {
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
    .tile.enter,
    .seal.stamp,
    .short,
    .buy.shake {
      animation: none;
    }
  }
  @media (max-width: 47.99rem) {
    .tile {
      gap: 0.5rem;
      padding: 0.625rem;
    }
    .art {
      height: 6rem;
    }
    .plate {
      font-size: calc(1.125rem * var(--plate-scale, 1));
    }
    h4 {
      font-size: 0.8rem;
    }
    .foot {
      flex-wrap: wrap;
    }
    .buy {
      flex: 1 0 auto;
      min-height: 2.75rem;
    }
  }
</style>
