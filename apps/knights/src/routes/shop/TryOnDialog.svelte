<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import { count } from '$lib/format';
  import Icon from '$lib/Icon.svelte';
  import { modal } from '$lib/modal';
  import {
    buyClick,
    cosmeticIcon,
    cosmeticTypeLabel,
    frameStyle,
    nameplateBackground,
    packNote,
  } from '$lib/shop-view';
  import '$lib/overlay.css';
  import type { PageData } from './$types';

  type Card = NonNullable<PageData['shop']>['cards'][number];

  let {
    card,
    username,
    avatarUrl,
    rankLine,
    balance,
    onclose,
    onbuy,
  }: {
    card: Card;
    username: string;
    avatarUrl: string | null;
    rankLine: string;
    balance: { held: boolean; convertible: number };
    onclose: () => void;
    /** Called only when the purse covers the price and spending is open; the confirm dialog takes it from there. */
    onbuy: (card: Card) => void;
  } = $props();

  let problem = $state<string | null>(null);

  const icon = $derived<ComponentProps<typeof Icon>['name']>(cosmeticIcon(card.kind, card.cosmeticType));
  const isFrame = $derived(card.cosmeticType === 'ProfileDecoration');
  const isBadge = $derived(card.cosmeticType === 'Badge');
  const isSticker = $derived(card.cosmeticType === 'Sticker');
  const frame = $derived(frameStyle(card.frameOffsets));
  const nameStyle = $derived(card.nameplate ? nameplateBackground(card.nameplate) : null);
  const typeLine = $derived(
    card.cosmeticType === 'NamePlate'
      ? 'Nameplate · colors your name across Civitai'
      : isFrame
      ? 'Avatar frame · worn around your avatar'
      : isBadge
      ? 'Badge · shown next to your name'
      : isSticker
      ? `Sticker${card.uses ? ` · ${count(card.uses)} uses` : ''}`
      : cosmeticTypeLabel(card.cosmeticType)
  );

  function buy() {
    const click = buyClick(balance, card.price);
    if (click.kind === 'confirm') onbuy(card);
    else problem = click.kind === 'short' ? `You need ${count(click.by)} more gold.` : click.text;
  }
</script>

<div
  class="ov-backdrop host"
  role="presentation"
  onclick={(event) => event.target === event.currentTarget && onclose()}
>
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="try-title"
    tabindex="-1"
    use:modal={{ onescape: onclose }}
  >
    <span class="grabber" aria-hidden="true"></span>
    <p class="ov-eyebrow">Try it on</p>
    <h2 id="try-title">{card.name}</h2>
    <p class="type">{typeLine}</p>

    <div class="stage">
      <p class="stage-label">How others see you</p>
      {#if isSticker}
        <div class="sticker">
          {#if card.image}<img src={card.image} alt={card.name} />{:else}<Icon name={icon} size={56} />{/if}
        </div>
      {:else}
        <div class="profile">
          <span class="avatar">
            {#if avatarUrl}<img class="photo" src={avatarUrl} alt="" />{:else}<span class="photo initial">{username.charAt(0).toUpperCase()}</span>{/if}
            {#if isFrame && card.image}
              <img
                class="frame"
                src={card.image}
                alt=""
                style:top={frame.top}
                style:left={frame.left}
                style:width={frame.width}
                style:height={frame.height}
              />
            {/if}
          </span>
          <span class="identity">
            <span class="name-row">
              <span class="name" class:painted={!!nameStyle} style:background-image={nameStyle}>{username}</span>
              {#if isBadge && card.image}<img class="badge" src={card.image} alt="" />{/if}
            </span>
            <span class="rank">{rankLine}</span>
          </span>
        </div>
      {/if}
      <p class="comment">
        <span class="mini">{#if avatarUrl}<img src={avatarUrl} alt="" />{/if}</span>
        <span class="name small" class:painted={!!nameStyle} style:background-image={nameStyle}>{username}</span>
        <span class="time">· 2h</span>
        <span class="text">Rightly judged, that one was PG-13.</span>
        {#if isSticker && card.image}<img class="inline-sticker" src={card.image} alt="" />{/if}
      </p>
    </div>

    <div class="price-row">
      <p class="price"><Icon name="coins" size={18} /><b>{count(card.price)}</b>{#if packNote(card)}<span class="per">· {packNote(card)}</span>{/if}</p>
      <p class="balance">You have {count(balance.convertible)} gold</p>
    </div>

    {#if card.state === 'available'}
      <button type="button" class="ov-primary" data-autofocus onclick={buy}>Buy for {count(card.price)} gold</button>
    {:else if card.state === 'rank'}
      <p class="unlock"><Icon name="lock" size={14} />Unlocks at {card.minRank}</p>
    {:else if card.state === 'owned'}
      <p class="unlock owned"><Icon name="check" size={14} />Owned</p>
    {:else}
      <p class="unlock">{card.state === 'sold-out' ? 'Gone for today' : 'Not available now'}</p>
    {/if}
    <button type="button" class="ov-secondary" data-autofocus={card.state !== 'available' ? '' : undefined} onclick={onclose}>Close</button>
    {#if problem}<p class="problem" role="alert">{problem}</p>{/if}
  </div>
</div>

<style>
  .dialog {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    width: min(32.5rem, 100%);
    max-height: 100%;
    padding: 2rem;
    overflow-y: auto;
    border: 1.5px solid var(--io-gold);
    border-radius: 8px;
    background: var(--io-surface);
    text-align: center;
  }
  .grabber {
    display: none;
  }
  h2 {
    margin: 0;
    color: var(--io-parchment);
    font: 700 1.5rem/1.2 var(--io-font-display);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .type {
    margin: -0.5rem 0 0;
    color: var(--io-parchment-muted);
    font: 400 0.82rem/1.4 var(--io-font-ui);
  }
  .stage {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    width: 100%;
    padding: 1.25rem;
    border-radius: 6px;
    background: var(--io-matte);
    text-align: left;
  }
  .stage-label {
    margin: 0;
    color: var(--io-parchment-muted);
    font: 600 0.625rem/1.2 var(--io-font-ui);
    letter-spacing: 0.2em;
    text-transform: uppercase;
  }
  .profile {
    display: flex;
    align-items: center;
    gap: 0.875rem;
    padding: 1rem;
    border: 1px solid var(--io-gold-muted);
    border-radius: 6px;
    background: var(--io-surface);
  }
  .avatar {
    position: relative;
    flex: none;
    width: 4rem;
    height: 4rem;
  }
  .photo {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    background: #4a4236;
    object-fit: cover;
  }
  .initial {
    color: var(--io-parchment);
    font: 700 1.4rem/1 var(--io-font-display);
  }
  .frame {
    position: absolute;
    max-width: none;
    pointer-events: none;
  }
  .identity {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    min-width: 0;
  }
  .name-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .name {
    overflow: hidden;
    color: var(--io-parchment);
    font: 700 1.375rem/1.2 var(--io-font-display);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name.small {
    flex: none;
    font: 700 0.82rem/1.2 var(--io-font-ui);
  }
  .name.painted {
    background-clip: text;
    -webkit-background-clip: text;
    color: transparent;
  }
  .badge {
    flex: none;
    width: 1.5rem;
    height: 1.5rem;
    object-fit: contain;
  }
  .rank,
  .time,
  .balance {
    color: var(--io-parchment-muted);
    font: 400 0.75rem/1.3 var(--io-font-ui);
  }
  .sticker {
    display: grid;
    place-items: center;
    height: 9rem;
    color: var(--io-gold);
  }
  .sticker img {
    max-width: 9rem;
    max-height: 9rem;
    object-fit: contain;
  }
  .comment {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    margin: 0;
  }
  .mini {
    flex: none;
    width: 1.375rem;
    height: 1.375rem;
    overflow: hidden;
    border-radius: 50%;
    background: #4a4236;
  }
  .mini img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .text {
    color: var(--io-parchment);
    font: 400 0.82rem/1.3 var(--io-font-ui);
  }
  .inline-sticker {
    width: 2rem;
    height: 2rem;
    object-fit: contain;
  }
  .price-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    width: 100%;
  }
  .price {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0;
    color: var(--io-gold);
  }
  .price b {
    font: 700 1.375rem/1 var(--io-font-display);
    letter-spacing: 0.04em;
  }
  .price .per {
    color: var(--io-parchment-muted);
    font: 400 0.8rem/1.2 var(--io-font-ui);
  }
  .balance {
    margin: 0;
  }
  .ov-primary,
  .ov-secondary {
    width: 100%;
  }
  .unlock {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    width: 100%;
    min-height: 48px;
    margin: 0;
    border: 1px solid var(--io-gold-muted);
    border-radius: 6px;
    color: var(--io-parchment-muted);
    font: 700 0.9rem/1 var(--io-font-display);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .unlock.owned {
    border-color: var(--io-verdigris);
    color: var(--io-verdigris);
  }
  .problem {
    margin: 0;
    color: var(--io-crimson-text);
    font: 600 0.9rem/1.4 var(--io-font-ui);
  }
  @media (max-width: 47.99rem) {
    .host {
      align-items: flex-end;
      padding: 0;
    }
    .dialog {
      width: 100%;
      max-height: 90dvh;
      gap: 0.75rem;
      padding: 0.75rem 1.25rem 1.5rem;
      border-width: 1.5px 0 0;
      border-radius: 12px 12px 0 0;
    }
    .grabber {
      display: block;
      width: 2.5rem;
      height: 0.25rem;
      margin-bottom: 0.5rem;
      border-radius: 2px;
      background: var(--io-gold-muted);
    }
    h2 {
      font-size: 1.25rem;
    }
    .stage {
      padding: 0.875rem;
    }
    .avatar {
      width: 3.25rem;
      height: 3.25rem;
    }
    .name {
      font-size: 1.2rem;
    }
  }
</style>
