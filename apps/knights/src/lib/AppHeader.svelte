<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { page } from '$app/state';
  import { afterNavigate } from '$app/navigation';
  import Avatar from './Avatar.svelte';
  import HeaderStats from './HeaderStats.svelte';
  import Icon from './Icon.svelte';
  import PrimaryNav from './PrimaryNav.svelte';
  import RankBadge from './RankBadge.svelte';
  import RecapButton from './RecapButton.svelte';
  import FeedbackDialog from './FeedbackDialog.svelte';
  import RestartCareerDialog from './RestartCareerDialog.svelte';
  import { rankPill } from './chrome';
  import { sound } from './sound';
  import type { PlayerBadge } from './player-badge';
  import type { PlayerStatus } from './server/player-status';

  type Streak = { streak: number; shields: number; maxShields: number };
  type LadderRow = { rank: string; fromLevel: number; accuracyBar: number; minDaysPlayed?: number };
  let {
    player,
    userId = null,
    civitaiUrl,
    shopOpen,
    isPlayer = false,
    feedbackOpen = false,
    status,
    streak,
    recapUnseen = false,
    goldPerBuzz,
    ladder,
    badges,
  }: {
    player: PlayerBadge | null;
    /** Keys this player's sound setting in the browser. */
    userId?: number | null;
    civitaiUrl: string;
    shopOpen: boolean;
    /** Whether the viewer has a career, and so can restart it. */
    isPlayer?: boolean;
    feedbackOpen?: boolean;
    status?: PlayerStatus;
    streak?: Streak;
    /** Today's recap has not been seen: the recap button wears a dot. */
    recapUnseen?: boolean;
    goldPerBuzz: number;
    ladder: LadderRow[];
    /** Rank badge image addresses by rank; a rank without one shows the crest. */
    badges: { small: Record<string, string> };
  } = $props();

  let open = $state(false);
  let restarting = $state(false);
  let sendingFeedback = $state(false);
  let wrapper = $state<HTMLElement>();
  let trigger = $state<HTMLButtonElement>();
  let panel = $state<HTMLElement>();

  const links = $derived([
    { href: '/play', label: 'Play', icon: 'play' as const },
    { href: '/judgments', label: 'Judgments', icon: 'scroll-text' as const },
    ...(shopOpen ? [{ href: '/shop', label: 'Shop', icon: 'coins' as const }] : []),
    { href: '/leaderboard', label: 'Leaderboard', icon: 'crown' as const },
    { href: '/codex', label: 'Codex', icon: 'book-open' as const },
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

  // Sound stays silent until the first click or key press, and the choice to mute is remembered per player. The toggle
  // itself sits with the play controls, since sounds only play while judging.
  onMount(() => {
    sound.attach(window);
    sound.setPlayer(userId);
  });
</script>

<svelte:window {onkeydown} />

<header>
  <a class="brand" href="/home">
    <Icon name="shield" size={24} />
    <span class="title">Knights of New Order</span>
    <span class="wordmark">Knights</span>
  </a>

  <PrimaryNav />

  {#if status}
    <HeaderStats {status} {streak} {goldPerBuzz} {shopOpen} {ladder} />
  {/if}

  {#if player}
    <RecapButton unseen={recapUnseen} />
    <div class="account" bind:this={wrapper} {onfocusout}>
      <button
        type="button"
        class="trigger"
        aria-expanded={open}
        aria-controls="avatar-menu"
        aria-label={`Account menu for ${player.username}`}
        bind:this={trigger}
        onclick={toggle}
      >
        <span class="portrait">
          <Avatar src={player.avatarUrl} name={player.username} size={32} />
          {#if status}
            <span class="rank-badge"><RankBadge rank={status.rank} src={badges.small[status.rank]} size={16} /></span>
          {/if}
        </span>
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
          <hr />
          <a href={civitaiUrl}><Icon name="arrow-left" size={18} />Back to Civitai</a>
          {#if feedbackOpen}
            <button
              type="button"
              class="item"
              onclick={() => {
                close(true);
                sendingFeedback = true;
              }}
            >
              <Icon name="send" size={18} />Send feedback
            </button>
          {/if}
          {#if isPlayer}
            <button
              type="button"
              class="restart"
              onclick={() => {
                // Focus goes back to the trigger first: the dialog returns focus to whatever opened it, and this item unmounts.
                close(true);
                restarting = true;
              }}
            >
              <Icon name="rotate-ccw" size={18} />Restart career…
            </button>
          {/if}
          <a class="out" href="/logout" data-sveltekit-reload>
            <Icon name="log-out" size={18} />Sign out
          </a>
        </nav>
      {/if}
    </div>
  {/if}
</header>

{#if restarting}
  <RestartCareerDialog onclose={() => (restarting = false)} />
{/if}

{#if sendingFeedback}
  <FeedbackDialog onclose={() => (sendingFeedback = false)} />
{/if}

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
    margin-right: 12px;
    min-width: 0;
    color: var(--io-gold);
    text-decoration: none;
  }
  .brand :global(svg) {
    flex: none;
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
  .portrait {
    position: relative;
    display: inline-flex;
    width: 36px;
    height: 34px;
  }
  .rank-badge {
    position: absolute;
    right: 0;
    bottom: 0;
    display: inline-flex;
    border: 1.5px solid var(--io-gold);
    border-radius: 50%;
    background: var(--io-surface);
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
  nav .item {
    color: var(--io-parchment);
  }
  nav a :global(svg),
  nav .item :global(svg) {
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
  nav .item,
  nav .restart {
    display: flex;
    align-items: center;
    gap: 12px;
    justify-content: flex-start;
    min-height: 44px;
    padding: 0 12px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    font: 600 15px/1.2 var(--io-font-ui);
    text-align: left;
  }
  nav .item:hover,
  nav .restart:hover:not(:disabled) {
    background: var(--io-bg);
  }
  nav .restart,
  nav .restart :global(svg),
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

  /* Beside the tabs and the stats there is room for the wordmark only until 90rem. */
  @media (min-width: 75.0625rem) and (max-width: 89.9375rem) {
    .title {
      display: none;
    }
    .wordmark {
      display: inline;
      font-size: 15px;
      letter-spacing: 1px;
    }
  }

  @media (max-width: 40rem) {
    header {
      height: 52px;
      gap: 6px;
      padding: 0 12px;
    }
    .brand {
      gap: 8px;
      margin-right: auto;
    }
    .brand :global(svg) {
      width: 20px;
      height: 20px;
    }
    .title {
      display: none;
    }
    .wordmark {
      display: inline;
      font-size: 13px;
      letter-spacing: 0.5px;
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
