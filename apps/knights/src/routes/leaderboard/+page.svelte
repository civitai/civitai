<script lang="ts">
  import { count } from '$lib/format';
  import RankEmblem from '$lib/RankEmblem.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  type Row = PageData['entries'][number];
  let failed = $state<Record<number, boolean>>({});
  let badgeFailed = $state<Record<string, boolean>>({});
  const outside = $derived(data.self && data.self.position > data.entries.length ? data.self : null);
</script>

{#snippet row(entry: Row)}
  <li class="entry" class:me={entry.userId === data.viewerId}>
    <span class="position" aria-label="Position {entry.position}">{entry.position}</span>
    {#if entry.avatarUrl && !failed[entry.userId]}
      <img
        src={entry.avatarUrl}
        alt=""
        width="32"
        height="32"
        loading="lazy"
        onerror={() => (failed[entry.userId] = true)}
      />
    {:else}
      <span class="avatar" aria-hidden="true">{entry.username[0].toUpperCase()}</span>
    {/if}
    <span class="who">
      {#if entry.profileUrl}
        <a class="name" href={entry.profileUrl}>{entry.username}</a>
      {:else}
        <span class="name">{entry.username}</span>
      {/if}
      <span class="sub">
        {#if entry.badgeUrl && !badgeFailed[entry.rankType]}
          <img
            class="badge"
            src={entry.badgeUrl}
            alt=""
            width="24"
            height="24"
            loading="lazy"
            onerror={() => (badgeFailed[entry.rankType] = true)}
          />
        {:else}
          <RankEmblem rank={entry.rankType} size="xs" />
        {/if}
        <span class="rank">{entry.rankType} · Level {entry.level}</span>
      </span>
    </span>
    <span class="fervor"><b>{count(entry.fervor)}</b><span>fervor</span></span>
  </li>
{/snippet}

<div class="page-wide">
  <p class="eyebrow">Knights of New Order</p>
  <h1 class="page-title">Most devoted this week</h1>
  <p class="lede">
    Fervor from the judgments cast in the last {data.windowDays} days. Knights, Templars and
    Paladins appear once they have some. The board updates daily.
  </p>

  {#if data.entries.length === 0}
    <p class="empty">No one has earned fervor this week yet.</p>
  {:else}
    <ol class="rows board" aria-label="Most devoted this week">
      {#each data.entries as entry (entry.userId)}
        {@render row(entry)}
      {/each}
    </ol>
  {/if}

  {#if outside}
    <p class="gap" aria-hidden="true">· · ·</p>
    <ol class="rows board" aria-label="Your position" start={outside.position}>
      {@render row(outside)}
    </ol>
  {:else if !data.self}
    <p class="note">
      You are not on the board this week. Judge as a Knight or above and your fervor will place you.
    </p>
  {/if}
</div>

<style>
  .board {
    list-style: none;
  }
  .entry {
    display: grid;
    grid-template-columns: 2.5rem 2rem minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.75rem;
    min-height: 3.5rem;
    padding: 0.5rem 0.25rem;
    font-family: var(--io-font-ui);
  }
  .me {
    background: var(--io-surface);
    box-shadow: inset 3px 0 0 var(--io-gold);
  }
  .position {
    color: var(--io-gold);
    font: 700 1.1rem/1 var(--io-font-display);
    text-align: right;
  }
  .entry > img,
  .avatar {
    width: 2rem;
    height: 2rem;
    border: 1px solid var(--io-gold);
    border-radius: 50%;
    background: var(--io-bg);
  }
  .entry > img {
    object-fit: cover;
  }
  .avatar {
    display: grid;
    place-items: center;
    color: var(--io-gold);
    font: 700 0.85rem/1 var(--io-font-display);
  }
  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .name {
    overflow: hidden;
    color: var(--io-parchment);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-width: 0;
    color: var(--io-parchment-muted);
    font-size: 0.8rem;
  }
  .badge {
    flex: none;
    width: 1.5rem;
    height: 1.5rem;
    object-fit: contain;
  }
  .rank {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fervor {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    color: var(--io-parchment-muted);
    font-size: 0.7rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .fervor b {
    color: var(--io-gold);
    font: 700 1.1rem/1.1 var(--io-font-display);
    letter-spacing: 0;
  }
  .gap {
    margin: 0.5rem 0;
    color: var(--io-parchment-muted);
    text-align: center;
  }
  .empty,
  .note {
    color: var(--io-parchment-muted);
  }
  @media (max-width: 40rem) {
    .entry {
      grid-template-columns: 1.75rem 2rem minmax(0, 1fr) auto;
      gap: 0.5rem;
    }
  }
</style>
