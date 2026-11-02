<script lang="ts">
  import { enhance } from '$app/forms';
  import Icon from '$lib/Icon.svelte';
  import RankEmblem from '$lib/RankEmblem.svelte';
  import SmiteNotice from '$lib/SmiteNotice.svelte';
  import { accuracyLine, heartsLeft, nextRankLine, restartLosses } from '$lib/chrome';
  import { count, formatDate } from '$lib/format';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  let warning = $state(false);
  let submitting = $state(false);
  let attempted = $state(false);
  let restarting = $state(false);
  let restartSubmitting = $state(false);
  let restartAttempted = $state(false);

  const status = $derived(data.status);
  const hearts = $derived(status ? heartsLeft(status) : 0);
  const accuracy = $derived(status ? accuracyLine(status) : null);
  const next = $derived(status ? nextRankLine(status) : null);
  const losses = $derived(
    status && data.player ? restartLosses({ ...status, exp: data.player.exp }) : []
  );

  const LINKS = [
    { href: '/judgments', icon: 'scroll-text', title: 'Judgments', note: 'Every verdict you have earned' },
    { href: '/gold', icon: 'coins', title: 'Gold', note: 'Convert earned gold to Buzz' },
    { href: '/ranks', icon: 'shield', title: 'Ranks', note: 'The ladder and its bars' },
    { href: '/rules', icon: 'book-open', title: 'Rules', note: 'How the Order judges' },
  ] as const;
</script>

{#if data.player && status}
  {#if restarting}
    <div class="page-wide restart-page">
      <div class="restart-copy">
        <p class="eyebrow crimson">Restart career</p>
        <h1 class="page-title">Begin again as an Acolyte?</h1>
        <p class="lede dark">Restarting your career cannot be undone. You will lose:</p>
        <ul class="rows losses">
          {#each losses as loss (loss.title)}
            <li>
              <span class="x"><Icon name="x" size={20} /></span>
              <div>
                <p class="loss-title">{loss.title}</p>
                <p class="loss-detail">{loss.detail}</p>
              </div>
            </li>
          {/each}
        </ul>
        <p class="kept"><Icon name="shield-check" size={20} />Gold you have already converted stays with you.</p>
        <form
          method="POST"
          action="?/restart"
          class="actions"
          use:enhance={() => {
            restartSubmitting = true;
            restartAttempted = true;
            return async ({ update }) => {
              try {
                await update();
              } finally {
                restartSubmitting = false;
              }
            };
          }}
        >
          <input type="hidden" name="confirmed" value="yes" />
          <button type="submit" class="btn danger solid" disabled={restartSubmitting}>
            Yes, restart my career
          </button>
          <button
            type="button"
            class="btn"
            onclick={() => {
              restarting = false;
              restartAttempted = false;
            }}
            disabled={restartSubmitting}>Cancel</button
          >
        </form>
        {#if restartAttempted && form?.restartFailed}
          <p class="notice" role="alert">{form.message}</p>
        {/if}
      </div>
      <aside class="journey" aria-hidden="true">
        <RankEmblem rank={status.rank} dim />
        <p class="rank-name dimmed">{status.rank}</p>
        <p class="rank-sub">Level {status.level}</p>
        <span class="arrow"><Icon name="arrow-left" size={24} /></span>
        <RankEmblem rank="Acolyte" />
        <p class="rank-name">Acolyte</p>
        <p class="rank-sub">The Trials</p>
      </aside>
    </div>
  {:else}
    <div class="page-wide home">
      <div class="standing-col">
        <p class="eyebrow">Welcome back{data.username ? `, ${data.username}` : ''}</p>
        <h1 class="page-title">Your standing in the Order</h1>

        <div class="standing">
          <div class="emblem-col">
            <RankEmblem rank={status.rank} size="lg" />
            <p class="rank-name">{status.rank}</p>
          </div>
          <div class="level">
            <p class="level-title label-caps">Level {status.level}</p>
            <p class="xp">{count(status.xpIntoLevel)} / {count(status.xpForNextLevel)} XP to level {status.level + 1}</p>
            <div class="bar" aria-hidden="true"><div class="fill" style:width="{status.progressPercent}%"></div></div>
            {#if accuracy}<p class="line">{accuracy}</p>{/if}
            {#if next}<p class="line">{next}</p>{/if}
          </div>
        </div>

        <ul class="pills" aria-label="Your numbers">
          <li class="pill-stat"><Icon name="coins" /><b>{count(status.goldEarned)}</b><span>gold earned</span></li>
          <li class="pill-stat"><Icon name="hourglass" /><b>{count(status.goldPending)}</b><span>gold pending</span></li>
          {#if data.daily}
            <li class="pill-stat"><Icon name="flame" /><b>{data.daily.streak}</b><span>day streak</span></li>
          {/if}
          <li class="pill-stat"><Icon name="zap" /><b>{count(status.fervor)}</b><span>fervor</span></li>
          <li class="pill-stat"><Icon name="heart" /><b>{hearts} of {status.maxSmites}</b><span>hearts</span></li>
          <li class="sworn">Sworn in on {formatDate(data.player.startAt)}</li>
        </ul>

        {#if status.smites > 0}
          <SmiteNotice smites={status.smites} maxSmites={status.maxSmites} />
        {/if}
      </div>

      <div class="restart-wrap">
        <div class="divider" aria-hidden="true"><span></span></div>

        <section class="restart" aria-labelledby="restart-title">
          <div>
            <h2 id="restart-title" class="label-caps">Start over</h2>
            <p class="muted">Start over as an Acolyte.</p>
          </div>
          <button type="button" class="btn danger" onclick={() => (restarting = true)}>
            Restart career
          </button>
        </section>
      </div>

      <nav class="order" aria-label="The Order">
        <p class="eyebrow">The Order</p>
        <a class="btn primary block" href="/play" data-sveltekit-preload-data="off">Begin judging</a>
        <ul class="rows links">
          {#each LINKS as link (link.href)}
            <li>
              <a href={link.href}>
                <Icon name={link.icon} size={22} />
                <span class="text">
                  <span class="link-title label-caps">{link.title}</span>
                  <span class="link-note">{link.note}</span>
                </span>
                <Icon name="chevron-right" size={20} />
              </a>
            </li>
          {/each}
        </ul>
      </nav>
    </div>
  {/if}
{:else}
  <div class="page-wide join">
    <div class="oath">
      <p class="eyebrow">The oath</p>
      <h1 class="page-title">Join the Order</h1>
      <div class="divider" aria-hidden="true"><span></span></div>
      <p class="vow">I will rate what the image shows, not what I would like to see.</p>
      <p class="vow">I will judge in good faith, and let the Order's verdict stand.</p>
      <p class="vow">I will begin as an Acolyte, and earn my rank in the Trials.</p>
      <p class="small muted">
        Knights judge how mature images should be rated. New members begin as Acolytes and prove
        themselves in the Trials. <a href="/rules">Read the rules</a> first if you like.
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
            return async ({ update }) => {
              try {
                await update();
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
        {#if attempted && form?.message && !form.restartFailed}
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
    grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr);
    grid-template-areas:
      'main order'
      'restart order';
    grid-template-rows: auto 1fr;
    column-gap: 3rem;
    align-items: start;
  }
  .standing-col {
    grid-area: main;
  }
  .restart-wrap {
    grid-area: restart;
  }
  .order {
    grid-area: order;
  }
  .standing {
    display: flex;
    gap: 2rem;
    align-items: flex-start;
    margin-bottom: 1.5rem;
  }
  .emblem-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    min-width: 6rem;
  }
  .rank-name {
    color: var(--io-parchment);
    font: 700 1rem/1.2 var(--io-font-display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .level {
    flex: 1;
    min-width: 0;
  }
  .level-title {
    color: var(--io-parchment);
    font-size: 1.6rem;
    line-height: 1.2;
  }
  .xp {
    margin: 0.5rem 0;
    font: 400 1rem/1.3 var(--io-font-ui);
  }
  .bar {
    height: 6px;
    margin-bottom: 0.9rem;
    border: 1px solid var(--io-gold-muted);
    border-radius: 3px;
    background: var(--io-matte);
  }
  .fill {
    height: 100%;
    background: var(--io-gold);
    border-radius: 3px;
  }
  .line {
    margin-top: 0.4rem;
    color: var(--io-parchment-muted);
    font: 400 0.95rem/1.4 var(--io-font-ui);
  }
  .pills {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
    margin: 0 0 1.5rem;
    padding: 0;
    list-style: none;
  }
  .sworn {
    color: var(--io-parchment-muted);
    font: 400 0.9rem/1.3 var(--io-font-ui);
  }
  .restart {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1.5rem;
  }
  .restart h2 {
    margin: 0 0 0.25rem;
    color: var(--io-parchment-muted);
    font-size: 1.05rem;
  }
  .order .btn {
    margin-bottom: 1rem;
  }
  .links a {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.9rem 0.25rem;
    color: var(--io-gold);
    text-decoration: none;
  }
  .links a:hover {
    background: color-mix(in srgb, var(--io-gold) 8%, transparent);
  }
  .text {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }
  .link-title {
    color: var(--io-parchment);
    font-size: 1rem;
  }
  .link-note {
    color: var(--io-parchment-muted);
    font: 400 0.95rem/1.3 var(--io-font-ui);
  }

  /* Restart confirmation */
  .restart-page {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 14rem;
    gap: 3rem;
    align-items: center;
    padding-top: 2rem;
  }
  .lede.dark {
    color: var(--io-parchment);
  }
  .losses li {
    display: flex;
    gap: 1rem;
    padding: 0.9rem 0;
  }
  .x {
    color: var(--io-crimson-text);
    padding-top: 0.15rem;
  }
  .loss-title {
    color: var(--io-parchment);
    font: 500 1.05rem/1.3 var(--io-font-ui);
  }
  .loss-detail {
    color: var(--io-parchment-muted);
  }
  .kept {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 1.25rem 0;
  }
  .kept :global(svg) {
    flex: none;
    color: var(--io-verdigris);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }
  .journey {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.4rem;
    text-align: center;
  }
  .dimmed {
    color: var(--io-parchment-muted);
  }
  .rank-sub {
    color: var(--io-parchment-muted);
    font: 400 0.9rem/1.3 var(--io-font-ui);
  }
  .arrow {
    margin: 0.5rem 0;
    color: var(--io-crimson-text);
    transform: rotate(-90deg);
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
    .restart-page,
    .join {
      grid-template-columns: minmax(0, 1fr);
      gap: 1.5rem;
    }
    .home {
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas: 'main' 'order' 'restart';
      grid-template-rows: auto;
    }
    .standing {
      gap: 1rem;
    }
    .restart {
      flex-direction: column;
      align-items: stretch;
    }
    .journey {
      flex-direction: row;
      flex-wrap: wrap;
      justify-content: center;
      gap: 1rem;
    }
    .arrow {
      transform: rotate(180deg);
    }
    .vow {
      font-size: 1.3rem;
    }
    .actions .btn {
      flex: 1;
    }
  }
</style>
