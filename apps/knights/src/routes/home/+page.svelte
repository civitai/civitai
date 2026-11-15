<script lang="ts">
  import { enhance } from '$app/forms';
  import { onMount } from 'svelte';
  import { goto, invalidate } from '$app/navigation';
  import Icon from '$lib/Icon.svelte';
  import RankBadge from '$lib/RankBadge.svelte';
  import SmiteNotice from '$lib/SmiteNotice.svelte';
  import VerdictsCard from '$lib/VerdictsCard.svelte';
  import { nextRankLine } from '$lib/chrome';
  import { count } from '$lib/format';
  import { pendingSegment } from '$lib/gauge';
  import { tween } from '$lib/motion';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  let warning = $state(false);
  let submitting = $state(false);
  let attempted = $state(false);

  const status = $derived(data.status);
  const next = $derived(status ? nextRankLine(status) : null);
  const segment = $derived(
    status ? pendingSegment(status.xpIntoLevel, status.xpForNextLevel, status.xpPending) : { confirmed: 0, pending: 0, overflow: 0 }
  );

  const links = $derived([
    { href: '/judgments', icon: 'scroll-text' as const, title: 'Judgments' },
    { href: '/leaderboard', icon: 'trophy' as const, title: 'Leaderboard' },
    { href: '/codex', icon: 'book-open' as const, title: 'Codex' },
    ...(data.shopOpen ? [{ href: '/shop', icon: 'coins' as const, title: 'Shop' }] : []),
  ]);

  // The stat counters tick up from zero once on load (a reduced-motion player gets the final numbers at once), and yesterday's
  // verdicts count as seen once the card is on screen, which also clears the header's recap dot.
  let shownGold = $state(0);
  let shownStreak = $state(0);
  let shownFervor = $state(0);
  onMount(() => {
    const cancels = [
      tween(0, status?.goldEarned ?? 0, 900, (v) => (shownGold = Math.round(v))),
      tween(0, data.daily?.streak ?? 0, 700, (v) => (shownStreak = Math.round(v))),
      tween(0, status?.fervor ?? 0, 900, (v) => (shownFervor = Math.round(v))),
    ];
    if (data.recap) {
      void fetch('/recap', { method: 'POST' })
        .then((response) => (response.ok ? invalidate('app:recap') : undefined))
        .catch(() => undefined);
    }
    return () => cancels.forEach((cancel) => cancel());
  });
</script>

<svelte:head>
  <title>Home · Knights of New Order</title>
</svelte:head>

{#if data.player && status}
  <div class="page-wide home">
    <section class="hero" aria-label="Your standing in the Order">
      <p class="eyebrow">Welcome back{data.username ? `, ${data.username}` : ''}</p>

      <div class="crest-wrap">
        <span class="glow" aria-hidden="true"></span>
        <svg class="ring" viewBox="0 0 224 224" aria-hidden="true" focusable="false">
          <circle class="track" cx="112" cy="112" r="106" />
          <circle
            class="ahead"
            cx="112"
            cy="112"
            r="106"
            pathLength="100"
            stroke-dasharray="{segment.pending * 100} {100 - segment.pending * 100}"
            stroke-dashoffset={-segment.confirmed * 100}
          />
          <circle
            class="fill"
            cx="112"
            cy="112"
            r="106"
            pathLength="100"
            stroke-dasharray="100"
            stroke-dashoffset={100 - segment.confirmed * 100}
          />
        </svg>
        <span class="crest"><RankBadge rank={status.rank} src={data.badges.large[status.rank]} size={176} /><span class="shimmer" aria-hidden="true"></span></span>
        <span class="level-pill">Lv {status.level}</span>
      </div>

      <h1 class="rank-name">{status.rank}</h1>
      <p class="xp">
        {count(status.xpIntoLevel)} / {count(status.xpForNextLevel)} XP to level {status.level + 1}{#if status.xpPending > 0}<span class="xp-pending"> · +{count(status.xpPending)} pending</span>{/if}
      </p>
      {#if next}<p class="line">{next}</p>{/if}

      <a class="btn primary begin" href="/play" data-sveltekit-preload-data="off">Begin judging</a>

      <ul class="stats" aria-label="Your numbers">
        <li>
          <b><Icon name="coins" size={18} />{count(shownGold)}</b>
          <span>Gold · {count(status.goldPending)} pending</span>
        </li>
        {#if data.daily}
          <li>
            <b><Icon name="flame" size={18} />{shownStreak} {data.daily.streak === 1 ? 'day' : 'days'}</b>
            <span>Streak</span>
          </li>
        {/if}
        <li>
          <b><Icon name="sparkles" size={18} />{count(shownFervor)}</b>
          <span>Fervor{data.fervorPosition ? ` · #${count(data.fervorPosition)}` : ''}</span>
        </li>
      </ul>

      {#if status.smites > 0}
        <SmiteNotice smites={status.smites} maxSmites={status.maxSmites} />
      {/if}
    </section>

    <div class="verdicts"><VerdictsCard recap={data.recap} /></div>

    <nav class="links" aria-label="The Order">
      <div class="divider" aria-hidden="true"><span></span></div>
      <ul>
        {#each links as link (link.href)}
          <li>
            <a href={link.href}><Icon name={link.icon} size={16} />{link.title}</a>
          </li>
        {/each}
      </ul>
    </nav>
  </div>
{:else}
  <div class="page-wide join">
    <div class="oath">
      <p class="eyebrow">The oath</p>
      <h1 class="page-title">Join the Order</h1>
      <div class="divider" aria-hidden="true"><span></span></div>
      <p class="vow">I will rate what the image shows, not what I would like to see.</p>
      <p class="vow">I will judge in good faith, and let the Order's verdict stand.</p>
      <p class="vow">I will begin as an Acolyte, and earn my rank as an apprentice.</p>
      <p class="small muted">
        Knights judge how mature images should be rated. New members begin as Acolytes and prove
        themselves as apprentices. <a href="/codex#judging">Read the Codex</a> first if you like.
      </p>
      {#if !warning}
        <p><button type="button" class="btn primary" onclick={() => (warning = true)}>Join the Order</button></p>
      {/if}
    </div>
    {#if warning}
      <section class="warning" aria-labelledby="warning-title">
        <h2 id="warning-title"><Icon name="triangle-alert" size={22} />Mature content warning</h2>
        <p>
          This game contains explicit and sensitive imagery, regardless of your on-site browsing
          level settings, that may not be suitable for all players. Images may be rated R, X or XXX.
        </p>
        <p class="adult"><b>18+</b>You must be an adult to take part.</p>
        <p class="muted">
          By continuing, you acknowledge that you are aware of the potential risks and agree to
          proceed at your own discretion.
        </p>
        <form
          method="POST"
          action="?/join"
          class="actions"
          use:enhance={() => {
            submitting = true;
            attempted = true;
            return async ({ result, update }) => {
              try {
                if (result.type === 'redirect') await goto(result.location, { invalidateAll: true });
                else await update();
              } finally {
                submitting = false;
              }
            };
          }}
        >
          <input type="hidden" name="accepted" value="yes" />
          <button type="submit" class="btn primary" disabled={submitting}>Agree and continue</button>
          <button
            type="button"
            class="btn"
            onclick={() => {
              warning = false;
              attempted = false;
            }}
            disabled={submitting}>Cancel</button
          >
        </form>
        {#if attempted && form?.message}
          <p class="notice" role="alert">{form.message}</p>
        {/if}
      </section>
    {/if}
  </div>
{/if}

<style>
  p {
    margin: 0;
  }
  .home {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 26rem);
    grid-template-areas: 'hero verdicts' 'links verdicts';
    grid-template-rows: auto 1fr;
    column-gap: 3rem;
    align-items: start;
  }
  .hero {
    grid-area: hero;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .verdicts {
    grid-area: verdicts;
    padding-top: 1.75rem;
  }
  .links {
    grid-area: links;
    width: 100%;
  }

  /* The crest sits in an XP ring: the ring fills on load, a shimmer crosses the badge once, and a glow breathes behind it. */
  .crest-wrap {
    position: relative;
    display: grid;
    place-items: center;
    width: 224px;
    height: 224px;
    margin: 0.5rem 0 1.25rem;
  }
  .glow {
    position: absolute;
    width: 264px;
    height: 264px;
    border-radius: 50%;
    background: radial-gradient(circle, rgb(201 162 74 / 0.22), transparent 68%);
    pointer-events: none;
  }
  .ring {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    transform: rotate(-90deg);
  }
  .ring circle {
    fill: none;
    stroke-width: 5;
  }
  .ring .track {
    stroke: var(--io-gold-muted);
    opacity: 0.5;
  }
  .ring .ahead {
    stroke: var(--io-gold);
    opacity: 0.4;
  }
  .ring .fill {
    stroke: var(--io-gold);
    animation: mo-gauge-fill 1100ms var(--ease-out-quart) 150ms both;
  }
  .crest {
    position: relative;
    display: inline-flex;
    overflow: hidden;
    border-radius: 50%;
  }
  .shimmer {
    position: absolute;
    inset: 0;
    background: linear-gradient(115deg, transparent 30%, rgb(232 220 192 / 0.35) 50%, transparent 70%);
    pointer-events: none;
    animation: mo-crest-shimmer 1100ms var(--ease-in-out) 500ms both;
  }
  .level-pill {
    position: absolute;
    bottom: 2px;
    padding: 3px 14px;
    border: 1px solid var(--io-gold);
    border-radius: 999px;
    background: var(--io-bg);
    color: var(--io-gold);
    font: 700 12px/1.4 var(--io-font-ui);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .rank-name {
    margin: 0;
    color: var(--io-parchment);
    font: 700 clamp(1.8rem, 5vw, 2.5rem) / 1.1 var(--io-font-display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .xp {
    margin: 0.5rem 0 0;
    font: 400 1rem/1.3 var(--io-font-ui);
  }
  .xp-pending {
    color: var(--io-gold);
  }
  .line {
    margin-top: 0.3rem;
    color: var(--io-parchment-muted);
    font: 400 0.9rem/1.4 var(--io-font-ui);
  }
  .begin {
    width: min(100%, 21rem);
    margin: 1.5rem 0 1.75rem;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    width: 100%;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .stats li {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 0 8px;
  }
  .stats li + li {
    border-left: 1px solid var(--io-gold-muted);
  }
  .stats b {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--io-parchment);
    font: 700 1.5rem/1.2 var(--io-font-display);
  }
  .stats b :global(svg) {
    color: var(--io-gold);
  }
  .stats span {
    color: var(--io-parchment-muted);
    font: 600 11px/1.3 var(--io-font-ui);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .links ul {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.5rem 1.75rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .links a {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    color: var(--io-gold);
    font: 600 14px/1.2 var(--io-font-ui);
    text-decoration: none;
  }
  .links a:hover {
    color: var(--io-parchment);
  }
  @media (prefers-reduced-motion: reduce) {
    .ring .fill,
    .shimmer {
      animation: none;
    }
    .shimmer {
      opacity: 0;
    }
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }

  /* Join the Order */
  .join {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 3rem;
    align-items: center;
    padding-top: 2rem;
  }
  .join:not(:has(.warning)) {
    grid-template-columns: minmax(0, 1fr);
  }
  .vow {
    margin-bottom: 1.25rem;
    color: var(--io-parchment);
    font-size: 1.6rem;
    font-style: italic;
    line-height: 1.4;
  }
  .small {
    margin: 1.5rem 0 1.25rem;
    font: 400 0.95rem/1.5 var(--io-font-ui);
  }
  .warning {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1.5rem;
    border: 1.5px solid var(--io-crimson);
    border-radius: 8px;
    background: var(--io-surface);
    font-size: 1.15rem;
  }
  .warning h2 {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin: 0;
    color: var(--io-crimson-text);
    font-size: 1.05rem;
    text-transform: uppercase;
  }
  .adult {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    align-self: flex-start;
    padding: 0.7rem 1rem;
    border-radius: 4px;
    background: color-mix(in srgb, var(--io-crimson) 22%, var(--io-bg));
    font: 400 1rem/1.3 var(--io-font-ui);
  }
  .adult b {
    color: var(--io-crimson-text);
    font: 700 1.4rem/1 var(--io-font-display);
  }

  @media (max-width: 47.99rem) {
    .join {
      grid-template-columns: minmax(0, 1fr);
      gap: 1.5rem;
    }
    .home {
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas: 'hero' 'verdicts' 'links';
      grid-template-rows: auto;
    }
    .verdicts {
      padding-top: 1.25rem;
    }
    .stats b {
      font-size: 1.15rem;
    }
    .stats span {
      letter-spacing: 0.08em;
    }
    .vow {
      font-size: 1.3rem;
    }
    .actions .btn {
      flex: 1;
    }
  }
</style>
