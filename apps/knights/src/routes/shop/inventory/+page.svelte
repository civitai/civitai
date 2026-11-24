<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import { enhance } from '$app/forms';
  import { page } from '$app/state';
  import { SvelteSet } from 'svelte/reactivity';
  import { count, formatDate } from '$lib/format';
  import Icon from '$lib/Icon.svelte';
  import { cosmeticIcon, cosmeticTypeLabel, tierName } from '$lib/shop-view';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  type Item = PageData['items'][number];
  type IconName = ComponentProps<typeof Icon>['name'];

  const FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'Badge', label: 'Badges' },
    { key: 'Sticker', label: 'Stickers' },
    { key: 'NamePlate', label: 'Nameplates' },
    { key: 'decoration', label: 'Avatar decorations' },
    { key: 'membership', label: 'Membership' },
  ] as const;
  let filter = $state<(typeof FILTERS)[number]['key']>('all');
  const busy = new SvelteSet<number>();

  const isDecoration = (type: string) => type === 'ProfileDecoration' || type === 'CardDecoration';
  const matches = (item: Item) =>
    filter === 'all'
      ? true
      : filter === 'membership'
      ? false
      : filter === 'decoration'
      ? isDecoration(item.type)
      : item.type === filter;
  const shown = $derived(data.items.filter(matches));
  const iconOf = (item: Item): IconName => cosmeticIcon(null, item.type);
  const typeLabel = (item: Item) => cosmeticTypeLabel(item.type);
  const metaOf = (item: Item) =>
    [
      typeLabel(item),
      item.type === 'Sticker'
        ? item.uses === null
          ? 'unlimited'
          : `${count(item.uses)} left`
        : item.origin === 'rank'
        ? 'rank reward'
        : null,
    ]
      .filter(Boolean)
      .join(' · ');
  const daysLeft = $derived(
    data.membership
      ? Math.max(0, Math.ceil((Date.parse(data.membership.endsAt) - Date.parse(data.now)) / 86_400_000))
      : 0
  );
  const showMembership = $derived((filter === 'all' || filter === 'membership') && data.membership);
</script>

<svelte:head>
  <title>Inventory · Knights of New Order</title>
</svelte:head>

<div class="page-wide inventory">
  <header class="head">
    <div>
      <p class="eyebrow">Your armory</p>
      <h1 class="page-title">Inventory</h1>
      <p class="lede">Equip what you own. Equipped cosmetics show on your Civitai profile, comments and avatar.</p>
    </div>
    <a class="back" href="/shop"><Icon name="store" size={16} />Shop</a>
  </header>

  <div class="filters" role="group" aria-label="Filter">
    {#each FILTERS as f (f.key)}
      <button type="button" class="chip" class:on={filter === f.key} aria-pressed={filter === f.key} onclick={() => (filter = f.key)}>
        {f.label}
      </button>
    {/each}
  </div>

  {#if !data.shopOpen}
    <p class="empty">The shop isn't open yet.</p>
  {/if}
  {#if form?.message && !form.ok}<p class="problem" role="alert">{form.message}</p>{/if}

  {#if showMembership && data.membership}
    <section class="member" aria-label="Membership">
      <Icon name="crown" size={22} />
      <div>
        <h2>{data.membership.tier ? `${tierName(data.membership.tier)} membership` : 'Membership'} · Active</h2>
        <p>
          Ends {formatDate(data.membership.endsAt)}
        </p>
      </div>
      <p class="days">{daysLeft} {daysLeft === 1 ? 'day' : 'days'} left</p>
    </section>
  {/if}

  {#if filter !== 'membership'}
    {#if data.shopOpen && shown.length === 0 && data.items.length > 0}
      <p class="empty">Nothing in this filter. Pick All to see everything you own.</p>
    {:else if data.shopOpen && shown.length === 0}
      <p class="empty">Nothing here yet. <a href="/shop">Visit the shop</a>.</p>
    {:else}
      <ul class="grid">
        {#each shown as item, i (item.cosmeticId)}
          <li class="item" class:equipped={item.equipped} style:--i={i < 6 ? i : null} class:enter={i < 6}>
            <div class="art" aria-hidden="true">
              {#if item.image}<img src={item.image} alt="" loading="lazy" />{:else}<Icon name={iconOf(item)} size={40} />{/if}
            </div>
            <h3>{item.name}</h3>
            <p class="meta">{metaOf(item)}</p>
            {#if item.type === 'Sticker'}
              <a class="act" href={page.data.civitaiUrl}>Use on Civitai</a>
            {:else}
              <form
                method="POST"
                action={item.equipped ? '?/unequip' : '?/equip'}
                use:enhance={() => {
                  busy.add(item.cosmeticId);
                  return async ({ update }) => {
                    try {
                      await update({ reset: false });
                    } finally {
                      busy.delete(item.cosmeticId);
                    }
                  };
                }}
              >
                <input type="hidden" name="cosmeticId" value={item.cosmeticId} />
                <button type="submit" class="act" class:on={item.equipped} disabled={busy.has(item.cosmeticId)} aria-pressed={item.equipped}>
                  {#if busy.has(item.cosmeticId)}
                    Working…
                  {:else if item.equipped}
                    <svg class="check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" pathLength="1" /></svg>
                    Equipped
                  {:else}
                    Equip
                  {/if}
                </button>
              </form>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {:else if !data.membership}
    <p class="empty">No membership yet.</p>
  {/if}
</div>

<style>
  p {
    margin: 0;
  }
  .head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 1.5rem;
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    min-height: 40px;
    color: var(--io-parchment-muted);
    font: 400 0.85rem/1 var(--io-font-ui);
    text-decoration: none;
  }
  .back {
    padding: 0 1rem;
    border: 1px solid var(--io-gold-muted);
    border-radius: 6px;
    color: var(--io-parchment);
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0.5rem 0 1.25rem;
  }
  .chip {
    min-height: 36px;
    padding: 0 0.9rem;
    border: 1px solid var(--io-gold-muted);
    border-radius: 999px;
    background: transparent;
    color: var(--io-parchment);
    font: 500 0.8rem/1 var(--io-font-ui);
    cursor: pointer;
  }
  .chip.on {
    border-color: var(--io-gold);
    background: var(--io-gold);
    color: var(--io-bg);
  }
  .member {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1.25rem;
    padding: 1rem 1.25rem;
    border: 1.5px solid var(--io-gold);
    border-radius: 8px;
    background: var(--io-surface);
    color: var(--io-gold);
  }
  .member > div {
    flex: 1;
  }
  .member h2 {
    margin: 0;
    color: var(--io-parchment);
    font: 700 1.05rem/1.3 var(--io-font-display);
    text-transform: uppercase;
  }
  .member p {
    color: var(--io-parchment-muted);
    font: 400 0.8rem/1.4 var(--io-font-ui);
  }
  .member .days {
    color: var(--io-gold);
    font: 700 0.75rem/1 var(--io-font-ui);
    letter-spacing: 0.15em;
    text-transform: uppercase;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .item {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 1rem;
    border: 1px solid var(--io-gold-muted);
    border-radius: 8px;
    background: var(--io-surface);
    transition: border-color var(--motion-base) var(--ease-out-quart);
  }
  .item.enter {
    animation: mo-rise-in var(--motion-base) var(--ease-out-quart) both;
    animation-delay: calc(var(--i, 0) * 40ms);
  }
  .item.equipped {
    border-color: var(--io-verdigris);
  }
  .art {
    display: grid;
    place-items: center;
    height: 120px;
    overflow: hidden;
    border-radius: 6px;
    background: var(--io-matte);
    color: var(--io-gold);
  }
  .art img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  h3 {
    margin: 0.25rem 0 0;
    color: var(--io-parchment);
    font: 700 1rem/1.25 var(--io-font-display);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .meta {
    color: var(--io-parchment-muted);
    font: 400 0.8rem/1.3 var(--io-font-ui);
  }
  form {
    margin-top: auto;
  }
  .act {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    width: 100%;
    min-height: 44px;
    margin-top: auto;
    border: 1px solid var(--io-gold);
    border-radius: 6px;
    background: transparent;
    color: var(--io-gold);
    font: 700 0.8rem/1 var(--io-font-display);
    letter-spacing: 0.15em;
    text-decoration: none;
    text-transform: uppercase;
    cursor: pointer;
    transition:
      color var(--motion-base) var(--ease-out-quart),
      border-color var(--motion-base) var(--ease-out-quart);
  }
  .act.on {
    border-color: var(--io-verdigris);
    color: var(--io-verdigris);
  }
  .check path {
    stroke-dasharray: 1;
    stroke-dashoffset: 0;
    animation: draw-check var(--motion-base) var(--ease-out-quart);
  }
  .empty,
  .problem {
    margin-top: 1rem;
    color: var(--io-parchment-muted);
    font: 400 0.95rem/1.5 var(--io-font-ui);
  }
  .problem {
    color: var(--io-crimson-text);
    font-weight: 600;
  }
  .empty a {
    color: var(--io-gold);
  }
  @keyframes draw-check {
    from {
      stroke-dashoffset: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .check path {
      animation: none;
    }
  }
  @media (max-width: 63.99rem) {
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 47.99rem) {
    .head {
      flex-direction: column;
      align-items: stretch;
    }
    .grid {
      grid-template-columns: 1fr;
    }
  }
</style>
