<script lang="ts">
  import { onMount } from 'svelte';
  import { compact, count } from '$lib/format';
  import Icon from '$lib/Icon.svelte';
  import RankEmblem from '$lib/RankEmblem.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  type Row = PageData['entries'][number];
  let failed = $state<Record<number, boolean>>({});
  let badgeFailed = $state<Record<string, boolean>>({});

  const podium = $derived(data.entries.length >= 3 ? data.entries.slice(0, 3) : []);
  const stage = $derived(podium.length ? [podium[1], podium[0], podium[2]] : []);
  const rows = $derived(podium.length ? data.entries.slice(3) : data.entries);

  // Open on a first visit; a collapse is remembered per viewer, and everything works without storage.
  let open = $state(true);
  const storageKey = $derived(`knights:fervor-panel-collapsed:${data.viewerId}`);
  onMount(() => {
    try {
      if (localStorage.getItem(storageKey) === '1') open = false;
    } catch {
      // Storage blocked: the panel stays open.
    }
  });
  function remember(event: Event) {
    open = (event.currentTarget as HTMLDetailsElement).open;
    try {
      localStorage.setItem(storageKey, open ? '0' : '1');
    } catch {
      // Not remembered.
    }
  }
</script>

{#snippet avatar(entry: Row, size: 'big' | 'mid' | 'row')}
  <span class="av {size}">
    {#if entry.avatarUrl && !failed[entry.userId]}
      <img
        src={entry.avatarUrl}
        alt=""
        loading="lazy"
        onerror={() => (failed[entry.userId] = true)}
      />
    {:else}
      <span class="initial" aria-hidden="true">{(entry.username[0] ?? 'K').toUpperCase()}</span>
    {/if}
    <span class="bdg">
      {#if entry.badgeUrl && !badgeFailed[entry.rankType]}
        <img
          src={entry.badgeUrl}
          alt=""
          loading="lazy"
          onerror={() => (badgeFailed[entry.rankType] = true)}
        />
      {:else}
        <RankEmblem rank={entry.rankType} size="xs" />
      {/if}
    </span>
  </span>
{/snippet}

{#snippet name(entry: Row)}
  {#if entry.profileUrl}
    <a class="name" href={entry.profileUrl}>{entry.username}</a>
  {:else}
    <span class="name">{entry.username}</span>
  {/if}
{/snippet}

{#snippet row(entry: Row, you: boolean, behind: { place: number; gap: number } | null)}
  <div class="entry" class:you>
    <span class="position">{entry.position}</span>
    {@render avatar(entry, 'row')}
    <span class="who">
      <span class="line">
        {@render name(entry)}
        {#if you}<span class="tag">YOU</span>{/if}
      </span>
      <span class="sub">
        {#if you}<span class="mine">You ·</span>{/if}{entry.rankType} · <span class="lv"
          >Level {entry.level}</span
        ><span class="lv-short">{entry.level}</span>
      </span>
    </span>
    <span class="fervor">
      <b>{count(entry.fervor)}</b>
      <span>{behind ? `${count(behind.gap)} behind #${behind.place}` : 'fervor'}</span>
    </span>
  </div>
{/snippet}

<div class="page-wide">
  <header class="title">
    <div>
      <p class="eyebrow">This week's vigil</p>
      <h1 class="heading">Most devoted</h1>
    </div>
    <p class="meta">
      <span>Fervor from judgments cast in the last {data.windowDays} days</span>
      <span class="tally"
        ><Icon name="hourglass" size={14} /> Tallied daily · next tally in {data.nextTally}</span
      >
    </p>
    <p class="meta-m">
      Fervor from judgments cast in the last {data.windowDays} days. Tallied daily · next tally in
      {data.nextTally}.
    </p>
  </header>

  <details class="how" bind:open ontoggle={remember}>
    <summary>
      <Icon name="scale" size={18} />
      <span class="how-title">How fervor works</span>
      <span class="chev"><Icon name="chevron-down" size={18} /></span>
    </summary>
    <p class="formula">{data.copy.formula}</p>
    <p class="muted-line">{data.copy.window}</p>
    <p class="muted-line">{data.copy.accuracy}</p>
    <p class="example">{data.copy.example}</p>
  </details>

  {#if data.entries.length === 0}
    <p class="note">No one has earned fervor this week yet.</p>
  {/if}

  {#if podium.length}
    <ol class="podium" aria-label="Top three">
      {#each stage as entry (entry.userId)}
        <li class="col p{entry.position}">
          {@render avatar(entry, entry.position === 1 ? 'big' : 'mid')}
          {@render name(entry)}
          <span class="sub"
            >{entry.rankType} · <span class="lv">Level {entry.level}</span><span class="lv-short"
              >{entry.level}</span
            ></span
          >
          <span class="pedestal">
            <span class="place">{entry.position}</span>
            <b class="value"><span class="full">{count(entry.fervor)}</span><span class="short">{compact(entry.fervor)}</span></b>
            <span class="label">fervor</span>
          </span>
        </li>
      {/each}
    </ol>
  {/if}

  <div class="body">
    {#if rows.length}
      <div class="list" role="list" aria-label="Most devoted this week">
        {#each rows as entry (entry.userId)}
          <div role="listitem" class="item">
            {@render row(entry, entry.userId === data.viewerId, null)}
          </div>
        {/each}
      </div>
      {#if data.entries.length >= data.size}
        <p class="more">Top {data.size} · scroll for more</p>
      {/if}
    {/if}

    <section class="standing" aria-label="Your standing">
      <p class="standing-label">Your standing</p>
      {#if data.self}
        {@render row(data.self, true, data.self.behind)}
      {:else}
        <p class="note">
          You are not on the board this week. Judge as a Knight or above and your fervor will place
          you.
        </p>
      {/if}
    </section>
  </div>
</div>

<style>
  p {
    margin: 0;
  }
  .title {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
  .title .eyebrow {
    margin-bottom: 0.25rem;
    letter-spacing: 3px;
  }
  .heading {
    margin: 0;
    color: var(--io-parchment);
    font: 700 34px/1.15 var(--io-font-display);
  }
  .meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.25rem;
    color: var(--io-parchment-muted);
    font: 400 0.9rem/1.3 var(--io-font-ui);
    text-align: right;
  }
  .tally {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--io-gold);
  }
  .meta-m {
    display: none;
  }

  .how {
    margin-bottom: 2rem;
    padding: 1rem 1.25rem;
    border-left: 2px solid var(--io-gold-muted);
    border-radius: 4px;
    background: var(--io-surface);
    font-family: var(--io-font-ui);
  }
  .how summary {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    color: var(--io-parchment);
    cursor: pointer;
    list-style: none;
  }
  .how summary::-webkit-details-marker {
    display: none;
  }
  .how summary :global(svg) {
    color: var(--io-gold);
  }
  .how-title {
    flex: 1;
    font-weight: 600;
  }
  .chev {
    display: inline-flex;
    transition: transform var(--motion-fast) var(--ease-out-quart);
  }
  .how[open] .chev {
    transform: rotate(180deg);
  }
  .formula {
    margin: 0.9rem 0 0.6rem;
    color: var(--io-gold);
    font: 700 1.1rem/1.3 var(--io-font-display);
  }
  .muted-line,
  .example {
    margin-top: 0.4rem;
    font-size: 0.9rem;
    line-height: 1.45;
  }
  .muted-line {
    color: var(--io-parchment-muted);
  }
  .example {
    color: var(--io-parchment);
  }

  /* Podium: places 2, 1, 3, bottom-aligned, first taller. */
  .podium {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    gap: 1rem;
    margin: 0 0 2rem;
    padding: 0;
    list-style: none;
  }
  .col {
    display: flex;
    flex: 1 1 0;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
    max-width: 17rem;
    font-family: var(--io-font-ui);
  }
  .col .name {
    max-width: 100%;
  }
  .col .sub {
    max-width: 100%;
  }
  .pedestal {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.1rem;
    width: 100%;
    margin-top: 0.4rem;
    border-top: 1px solid var(--io-gold-muted);
    background: var(--io-surface);
    height: 112px;
  }
  .p1 .pedestal {
    height: 156px;
    border-top: 2px solid var(--io-gold);
  }
  .p2 .pedestal {
    height: 128px;
  }
  .place {
    color: var(--io-parchment-muted);
    font: 700 2rem/1 var(--io-font-display);
  }
  .p1 .place {
    color: var(--io-gold);
    font-size: 2.6rem;
  }
  .value {
    color: var(--io-gold);
    font: 700 1.15rem/1.1 var(--io-font-display);
  }
  .short {
    display: none;
  }
  .label {
    color: var(--io-parchment-muted);
    font-size: 0.65rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  /* Avatars and the rank badge laid over their corner. */
  .av {
    position: relative;
    display: inline-flex;
    flex: none;
    width: var(--s);
    height: var(--s);
  }
  .av.big {
    --s: 96px;
    --b: 32px;
    --ring: 2px solid var(--io-gold);
  }
  .av.mid {
    --s: 80px;
    --b: 28px;
    --ring: 2px solid var(--io-gold-muted);
  }
  .av.row {
    --s: 44px;
    --b: 20px;
    --ring: 1px solid var(--io-gold-muted);
  }
  .av > img,
  .initial {
    width: 100%;
    height: 100%;
    border: var(--ring);
    border-radius: 50%;
    background: var(--io-bg);
    object-fit: cover;
  }
  .initial {
    display: grid;
    place-items: center;
    color: var(--io-gold);
    font: 700 1rem/1 var(--io-font-display);
  }
  .bdg {
    position: absolute;
    right: -4px;
    bottom: -4px;
    display: grid;
    place-items: center;
    width: var(--b);
    height: var(--b);
    overflow: hidden;
    border: 1.5px solid var(--io-gold);
    border-radius: 50%;
    background: var(--io-bg);
  }
  .bdg img {
    width: 80%;
    height: 80%;
    object-fit: contain;
  }
  .bdg :global(.emblem) {
    width: 100% !important;
    height: 100% !important;
    border: 0;
  }
  .bdg :global(svg) {
    width: 60%;
    height: 60%;
  }

  .name {
    overflow: hidden;
    color: var(--io-parchment);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-decoration: none;
  }
  .sub {
    overflow: hidden;
    color: var(--io-parchment-muted);
    font-size: 0.8rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lv-short,
  .mine {
    display: none;
  }

  /* Rows from 4 down, and the viewer's own. */
  .body {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .list,
  .standing,
  .entry {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
  }
  .list {
    order: 1;
    border-top: 1px solid var(--io-gold-muted);
  }
  .more {
    order: 2;
    margin: 0.75rem 0 0;
    color: var(--io-parchment-muted);
    font: 400 0.8rem/1 var(--io-font-ui);
    text-align: center;
  }
  .standing {
    order: 3;
    margin-top: 1.75rem;
  }
  .standing-label {
    margin-bottom: 0.6rem;
    color: var(--io-gold);
    font: 600 0.75rem/1.3 var(--io-font-ui);
    letter-spacing: 0.28em;
    text-transform: uppercase;
  }
  .entry {
    display: grid;
    grid-template-columns: 2.5rem 44px minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.9rem;
    min-height: 68px;
    padding: 0 0.5rem;
    font-family: var(--io-font-ui);
  }
  .item {
    border-bottom: 1px solid var(--io-gold-muted);
  }
  .entry.you {
    border: 1px solid var(--io-gold);
    border-radius: 6px;
    background: var(--io-surface);
  }
  .item .entry.you {
    border-radius: 0;
  }
  .position {
    color: var(--io-parchment-muted);
    font: 700 1.1rem/1 var(--io-font-display);
    text-align: center;
  }
  .you .position {
    color: var(--io-gold);
  }
  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .line > .name {
    min-width: 0;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .tag {
    flex: none;
    padding: 1px 8px;
    border: 1px solid var(--io-gold);
    border-radius: 999px;
    color: var(--io-gold);
    font: 700 0.65rem/1.4 var(--io-font-ui);
    letter-spacing: 0.1em;
  }
  .fervor {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    color: var(--io-parchment-muted);
    font-size: 0.65rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .fervor b {
    color: var(--io-gold);
    font: 700 1.1rem/1.1 var(--io-font-display);
    letter-spacing: 0;
  }
  .note {
    color: var(--io-parchment-muted);
    font-family: var(--io-font-ui);
  }

  @media (max-width: 40rem) {
    .title {
      display: block;
      margin-bottom: 1rem;
    }
    .heading {
      font-size: 28px;
    }
    .meta {
      display: none;
    }
    .meta-m {
      display: block;
      margin-top: 0.4rem;
      color: var(--io-parchment-muted);
      font: 400 0.85rem/1.4 var(--io-font-ui);
    }
    .how {
      margin-bottom: 1.5rem;
      padding: 0.85rem 1rem;
    }
    .podium {
      gap: 0.5rem;
      margin-bottom: 1.5rem;
    }
    .av.big {
      --s: 64px;
      --b: 24px;
    }
    .av.mid {
      --s: 52px;
      --b: 22px;
    }
    .av.row {
      --s: 36px;
      --b: 18px;
    }
    .pedestal {
      height: 84px;
    }
    .p1 .pedestal {
      height: 116px;
    }
    .p2 .pedestal {
      height: 96px;
    }
    .place {
      font-size: 1.5rem;
    }
    .p1 .place {
      font-size: 2rem;
    }
    .value {
      font-size: 0.95rem;
    }
    .full,
    .lv {
      display: none;
    }
    .short,
    .lv-short {
      display: inline;
    }
    .standing {
      order: 0;
      margin: 0 0 1.5rem;
    }
    .entry {
      grid-template-columns: 1.75rem 36px minmax(0, 1fr) auto;
      gap: 0.6rem;
      min-height: 60px;
    }
    .you .mine {
      display: inline;
      margin-right: 0.3em;
      color: var(--io-gold);
    }
    .you .tag {
      display: none;
    }
  }
</style>
