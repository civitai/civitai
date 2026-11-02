<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { page } from '$app/state';
  import { afterNavigate } from '$app/navigation';
  import Icon from './Icon.svelte';
  import { count } from './format';
  import { rankPill } from './chrome';
  import { tween } from './motion';
  import { rewardDeltas } from './rewards';
  import { sound } from './sound';
  import type { PlayerBadge } from './player-badge';
  import type { PlayerStatus } from './server/player-status';

  type Streak = { streak: number; shields: number; maxShields: number };
  let {
    player,
    userId = null,
    civitaiUrl,
    conversionOpen,
    status,
    streak,
  }: {
    player: PlayerBadge | null;
    /** Keys this player's sound setting in the browser. */
    userId?: number | null;
    civitaiUrl: string;
    conversionOpen: boolean;
    status?: PlayerStatus;
    streak?: Streak;
  } = $props();

  let open = $state(false);
  let avatarFailed = $state(false);
  let wrapper = $state<HTMLElement>();
  let trigger = $state<HTMLButtonElement>();
  let panel = $state<HTMLElement>();

  const links = $derived([
    { href: '/play', label: 'Play', icon: 'play' as const },
    { href: '/judgments', label: 'Judgments', icon: 'scroll-text' as const },
    ...(conversionOpen ? [{ href: '/gold', label: 'Convert gold', icon: 'coins' as const }] : []),
    { href: '/ranks', label: 'Ranks', icon: 'shield' as const },
    { href: '/rules', label: 'Rules', icon: 'book-open' as const },
  ]);

  async function toggle() {
    open = !open;
    if (open) {
      await tick();
      panel?.querySelector<HTMLElement>('a')?.focus();
    }
  }

  function close(returnFocus = false) {
    if (!open) return;
    open = false;
    if (returnFocus) trigger?.focus();
  }

  function onkeydown(event: KeyboardEvent) {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      close(true);
    }
  }

  function onfocusout(event: FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (open && next && !wrapper?.contains(next)) open = false;
  }

  afterNavigate(() => close());

  // Sound stays silent until the first click or key press, and the choice to mute is remembered per player.
  let muted = $state(false);
  onMount(() => {
    sound.attach(window);
    sound.setPlayer(userId);
    muted = sound.muted;
  });
  function toggleSound() {
    muted = !muted;
    sound.setMuted(muted);
  }

  // What a vote just earned floats up from its chip and the gold counter ticks to its new value. Ambient only: nothing
  // here waits on, or blocks, the next answer.
  let shownGold = $state(untrack(() => status?.goldEarned ?? 0));
  let floater = $state<{ id: number; xp: number; gold: number } | null>(null);
  let previous: PlayerStatus | null = null;
  let cancelTick: (() => void) | undefined;
  let floatTimer: ReturnType<typeof setTimeout> | undefined;
  let floatId = 0;

  $effect(() => {
    const next = status;
    if (!next) return;
    const deltas = rewardDeltas(previous, next);
    previous = next;
    if (deltas.goldEarned > 0) sound.play('gold');
    cancelTick?.();
    cancelTick = tween(untrack(() => shownGold), next.goldEarned, 360, (value) => (shownGold = Math.round(value)));
    if (deltas.xp > 0 || deltas.gold > 0) {
      floater = { id: ++floatId, xp: deltas.xp, gold: deltas.gold };
      clearTimeout(floatTimer);
      floatTimer = setTimeout(() => (floater = null), 500);
    }
  });
  $effect(() => () => {
    cancelTick?.();
    clearTimeout(floatTimer);
  });
</script>

<svelte:window {onkeydown} />

<header>
  <a class="brand" href="/">
    <Icon name="shield" size={24} />
    <span class="title">Knights of New Order</span>
    <span class="wordmark">Knights</span>
  </a>

  {#if status}
    <ul class="stats" aria-label="Your standing">
      {#if streak}
        <li
          class="pill wide"
          title="Shields: {streak.shields}/{streak.maxShields}. A shield covers one missed day."
        >
          <span class="flame"><Icon name="flame" /></span>
          {streak.streak}
          {streak.streak === 1 ? 'day' : 'days'} streak
        </li>
      {/if}
      <li
        class="pill wide"
        title="Gold earned: {count(status.goldEarned)}, pending: {count(status.goldPending)}"
      >
        <Icon name="coins" />
        {count(shownGold)}
        {#if floater && floater.gold > 0}
          {#key floater.id}<span class="floater" aria-hidden="true">+{count(floater.gold)} gold</span>{/key}
        {/if}
      </li>
      <li class="pill" title="Level {status.level}: {status.xpIntoLevel}/{status.xpForNextLevel} XP">
        <Icon name="swords" />
        {rankPill(status)}
        {#if floater && floater.xp > 0}
          {#key floater.id}<span class="floater" aria-hidden="true">+{count(floater.xp)} XP</span>{/key}
        {/if}
      </li>
    </ul>
  {/if}

  {#if player}
    <div class="account" bind:this={wrapper} {onfocusout}>
      <button
        type="button"
        class="trigger"
        aria-expanded={open}
        aria-controls="avatar-menu"
        aria-label="Account menu"
        bind:this={trigger}
        onclick={toggle}
      >
        {#if player.avatarUrl && !avatarFailed}
          <img
            src={player.avatarUrl}
            alt=""
            width="28"
            height="28"
            onerror={() => (avatarFailed = true)}
          />
        {:else}
          <span class="avatar" aria-hidden="true">{player.username[0].toUpperCase()}</span>
        {/if}
        <span class="name">{player.username}</span>
      </button>

      {#if open}
        <button type="button" class="scrim" tabindex="-1" aria-hidden="true" onclick={() => close(true)}
        ></button>
        <nav id="avatar-menu" aria-label="Account" bind:this={panel}>
          <a class="who" href={player.profileUrl}>
            <strong>{player.username}</strong>
            {#if status}<span>{rankPill(status)}</span>{/if}
          </a>
          <hr />
          {#each links as link (link.href)}
            <a
              href={link.href}
              aria-current={page.url.pathname === link.href ? 'page' : undefined}
              data-sveltekit-preload-data={link.href === '/play' ? 'off' : undefined}
              onclick={() => close()}
            >
              <Icon name={link.icon} size={18} />{link.label}
            </a>
          {/each}
          <button
            type="button"
            class="sound"
            role="switch"
            aria-checked={!muted}
            aria-label="Sound"
            onclick={toggleSound}
          >
            <Icon name={muted ? 'volume-x' : 'volume-2'} size={18} />Sound
            <span class="state">{muted ? 'Off' : 'On'}</span>
          </button>
          <hr />
          <a href={civitaiUrl}><Icon name="arrow-left" size={18} />Back to Civitai</a>
          <a class="out" href="/logout" data-sveltekit-reload>
            <Icon name="log-out" size={18} />Sign out
          </a>
        </nav>
      {/if}
    </div>
  {/if}
</header>

<style>
  header {
    display: flex;
    align-items: center;
    flex: none;
    gap: 20px;
    height: 64px;
    padding: 0 28px;
    border-bottom: 1px solid var(--io-gold-muted);
    background: var(--io-surface);
    font-family: var(--io-font-ui);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-right: auto;
    min-width: 0;
    color: var(--io-gold);
    text-decoration: none;
  }
  .title,
  .wordmark {
    font: 700 18px/1 var(--io-font-display);
    letter-spacing: 2px;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .wordmark {
    display: none;
  }
  .stats {
    display: flex;
    align-items: center;
    gap: 20px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .pill {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 999px;
    background: var(--io-bg);
    color: var(--io-parchment);
    font: 600 13px/1.2 var(--io-font-ui);
    white-space: nowrap;
  }
  .pill :global(svg) {
    color: var(--io-gold);
  }
  .floater {
    --rise: -14px;
    position: absolute;
    bottom: 70%;
    left: 50%;
    translate: -50% 0;
    color: var(--io-gold);
    font: 700 12px/1 var(--io-font-ui);
    pointer-events: none;
    animation: mo-float 480ms var(--ease-out-quart) both;
  }
  .pill .flame :global(svg) {
    color: var(--io-crimson-text);
  }
  .account {
    position: relative;
  }
  .trigger {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 0 4px;
    border: 0;
    border-radius: 999px;
    background: none;
    color: var(--io-parchment);
    font: 600 13px/1 var(--io-font-ui);
  }
  .trigger:hover:not(:disabled) {
    background: none;
    color: var(--io-gold);
  }
  .trigger img,
  .avatar {
    flex: none;
    width: 28px;
    height: 28px;
    border: 1px solid var(--io-gold);
    border-radius: 50%;
    background: var(--io-bg);
  }
  .trigger img {
    object-fit: cover;
  }
  .avatar {
    display: grid;
    place-items: center;
    color: var(--io-gold);
    font: 700 13px/1 var(--io-font-display);
  }
  .name {
    max-width: 12rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 20;
    min-height: 0;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    cursor: default;
  }
  .scrim:hover:not(:disabled) {
    background: transparent;
  }
  nav {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    z-index: 21;
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 252px;
    padding: 8px;
    border: 1px solid var(--io-gold);
    border-radius: 12px;
    background: var(--io-surface);
    box-shadow: 0 12px 32px #000000aa;
    animation: rise var(--motion-base) var(--ease-out-quart);
  }
  nav a {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 44px;
    padding: 0 12px;
    border-radius: 6px;
    color: var(--io-parchment);
    font: 600 15px/1.2 var(--io-font-ui);
    text-decoration: none;
  }
  nav a :global(svg),
  nav .sound :global(svg) {
    color: var(--io-gold);
  }
  nav .sound {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 44px;
    padding: 0 12px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--io-parchment);
    font: 600 15px/1.2 var(--io-font-ui);
    text-align: left;
  }
  nav .sound:hover:not(:disabled) {
    background: var(--io-bg);
  }
  nav .sound .state {
    margin-left: auto;
    color: var(--io-parchment-muted);
    font-size: 12px;
    font-weight: 400;
  }
  nav .sound[aria-checked='true'] .state {
    color: var(--io-gold);
  }
  nav a:hover,
  nav a[aria-current='page'] {
    background: var(--io-bg);
  }
  nav a[aria-current='page'] {
    color: var(--io-gold);
  }
  nav .who {
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 2px;
    padding: 8px 12px 12px;
  }
  nav .who strong {
    font-size: 14px;
  }
  nav .who span {
    color: var(--io-parchment-muted);
    font-size: 12px;
    font-weight: 400;
  }
  nav .out,
  nav .out :global(svg) {
    color: var(--io-crimson-text);
  }
  hr {
    width: 100%;
    height: 1px;
    margin: 4px 0;
    border: 0;
    background: var(--io-gold-muted);
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }

  @media (max-width: 40rem) {
    header {
      height: 52px;
      gap: 8px;
      padding: 0 16px;
    }
    .brand {
      gap: 8px;
    }
    .brand :global(svg) {
      width: 20px;
      height: 20px;
    }
    .title,
    .wide,
    .name {
      display: none;
    }
    .wordmark {
      display: inline;
      font-size: 14px;
      letter-spacing: 1px;
    }
    .stats {
      gap: 8px;
    }
    .pill {
      gap: 5px;
      padding: 5px 10px;
      font-size: 12px;
    }
    .pill :global(svg) {
      width: 14px;
      height: 14px;
    }
    .trigger {
      min-width: 44px;
      justify-content: center;
    }
    .scrim {
      background: #14110dd9;
    }
    .scrim:hover:not(:disabled) {
      background: #14110dd9;
    }
    nav {
      position: fixed;
      top: 60px;
      right: 16px;
    }
  }
</style>
