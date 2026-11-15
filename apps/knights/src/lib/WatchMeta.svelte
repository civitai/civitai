<script lang="ts">
  import HeartsRow from './HeartsRow.svelte';
  import Icon from './Icon.svelte';
  import { bump } from './motion';

  let {
    value,
    max,
    done,
    streak,
    hearts,
    maxHearts,
  }: { value: number; max: number; done: boolean; streak: number; hearts: number; maxHearts: number } = $props();
</script>

<!-- Below 1200px there is no rail: the Watch, the streak and the hearts sit in one quiet row above the question. -->
<div class="meta">
  {#if done}
    <span class="watch done"><Icon name="circle-check" size={14} />Watch complete</span>
  {:else}
    <span class="watch" use:bump={value}>Watch <b>{value}/{max}</b></span>
  {/if}
  <span class="streak"><Icon name="flame" size={14} /><b>{streak}</b> {streak === 1 ? 'day' : 'days'}</span>
  <HeartsRow {hearts} {maxHearts} />
</div>

<style>
  .meta {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 28px 0;
    color: var(--io-parchment-muted);
    font: 400 12px/1.2 var(--io-font-ui);
  }
  b {
    color: var(--io-parchment);
    font-weight: 600;
  }
  .watch {
    position: relative;
  }
  .watch b {
    display: inline-block;
  }
  @media (prefers-reduced-motion: no-preference) {
    .watch:global([data-bump]) b {
      animation: mo-bump-pop 400ms var(--ease-out-quart);
    }
    .watch:global([data-bump])::after {
      --rise: -10px;
      content: '+1';
      position: absolute;
      right: -14px;
      top: -4px;
      color: var(--io-gold);
      font: 700 11px/1 var(--io-font-ui);
      pointer-events: none;
      animation: mo-float 400ms var(--ease-out-quart) both;
    }
  }
  .done {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--io-parchment);
  }
  .done :global(svg) {
    color: var(--io-verdigris);
  }
  .streak {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .streak :global(svg) {
    color: var(--io-crimson-text);
  }
  @media (min-width: 75rem) {
    .meta {
      display: none;
    }
  }
  @media (max-width: 40rem) {
    .meta {
      padding: 6px 16px 0;
    }
  }
</style>
