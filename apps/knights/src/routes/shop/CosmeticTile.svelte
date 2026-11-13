<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import { count } from '$lib/format';
  import Icon from '$lib/Icon.svelte';
  import { cosmeticIcon, dealPercentOff, nameplateBackground, packNote } from '$lib/shop-view';
  import type { PageData } from './$types';

  type Card = NonNullable<PageData['shop']>['cards'][number];

  let {
    card,
    username,
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
  const gated = $derived(card.state === 'rank');
  const pack = $derived(packNote(card));
</script>

<article
  class="tile"
  class:gated
  class:deal={card.deal}
  class:owned={card.state === 'owned'}
  class:enter={index < 6}
  style:--i={index < 6 ? index : null}
  aria-labelledby="tile-{card.id}"
>
  <button type="button" class="preview" onclick={() => ontry(card)} aria-label="Try on {card.name}">
    <span class="art" class:dim={gated}>
      {#if card.nameplate}
        <span class="plate" style:background-image={nameplateBackground(card.nameplate)}>{username}</span>
      {:else if card.image}
        <img src={card.image} alt="" loading="lazy" />
      {:else}
        <Icon name={icon} size={40} />
      {/if}
    </span>
    <span class="try"><Icon name="eye" size={13} />Try on</span>
    {#if card.deal}<span class="tag">-{dealPercentOff(card.price, card.listPrice)}% today</span>{/if}
  </button>
  <h3 id="tile-{card.id}">{card.name}</h3>
  <div class="foot">
    <p class="price">
      <Icon name="coins" size={15} /><b>{count(card.price)}</b>
      {#if card.deal}<s>{count(card.listPrice)}</s>{/if}
      {#if pack}<span class="per">· {pack}</span>{/if}
    </p>
    {#if gated}
      <span class="lock"><Icon name="lock" size={12} />{card.minRank}+</span>
    {:else if card.state === 'owned'}
      <span class="seal" class:stamp={stamped}>Owned</span>
    {:else if card.state === 'available'}
      {#key shakeKey}
        <button
          type="button"
          class="buy"
          class:shake={(shortBy > 0 || !!refusal) && shakeKey > 0}
          onclick={() => onbuy(card)}
          aria-label="Buy {card.name} for {count(card.price)} gold"
        >
          Buy
        </button>
      {/key}
    {:else}
      <span class="state">{card.state === 'sold-out' ? 'Gone for today' : 'Not available now'}</span>
    {/if}
  </div>
  {#if refusal}<p class="short" role="status">{refusal}</p>
  {:else if shortBy > 0}<p class="short" role="status">You need {count(shortBy)} more gold.</p>{/if}
</article>

<style>
  .tile {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
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
    border-color: #3a3326;
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
  .preview:focus-visible {
    outline: 2px solid var(--io-parchment);
    outline-offset: 2px;
    border-radius: 4px;
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
  .plate {
    max-width: 100%;
    padding: 0 0.5rem;
    overflow: hidden;
    background-clip: text;
    -webkit-background-clip: text;
    color: transparent;
    font: 700 1.5rem/1.2 var(--io-font-display);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .try {
    position: absolute;
    right: 0.5rem;
    bottom: 0.5rem;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.2rem 0.45rem;
    border-radius: 3px;
    background: rgb(14 12 9 / 0.72);
    color: var(--io-gold-muted);
    font: 600 0.7rem/1.2 var(--io-font-ui);
  }
  .preview:hover .try {
    color: var(--io-gold);
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
  h3 {
    margin: 0;
    color: var(--io-parchment);
    font: 700 0.95rem/1.25 var(--io-font-display);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-top: auto;
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
    border: 0;
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
  .buy:focus-visible {
    outline: 2px solid var(--io-parchment);
    outline-offset: 2px;
  }
  .buy.shake {
    animation: tile-shake 240ms var(--ease-out-quart);
    background: transparent;
    border: 1px solid var(--io-crimson);
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
  .short {
    margin: 0;
    color: var(--io-crimson-text);
    font: 400 0.8rem/1.3 var(--io-font-ui);
    animation: mo-fade-in var(--motion-base) var(--ease-out-quart);
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
      font-size: 1.125rem;
    }
    h3 {
      font-size: 0.8rem;
    }
    .foot {
      flex-wrap: wrap;
    }
    .buy {
      min-height: 2.75rem;
      flex: 1 0 100%;
    }
  }
</style>
