<script lang="ts">
  import HeartsRow from './HeartsRow.svelte';
  import { heartBackShort } from './chrome';
  import Icon from './Icon.svelte';
  import { untrack } from 'svelte';
  import { bump } from './motion';
  import { sound } from './sound';
  import { watchBell } from './watch-bell';

  let {
    value,
    max,
    watch,
    done,
    streak,
    hearts,
    maxHearts,
    heartBack = null,
    onmore,
  }: {
    value: number;
    max: number;
    /** Names the Watch (`DailyStatus.watch`): the bell rings once per Watch. */
    watch: string;
    done: boolean;
    streak: number;
    hearts: number;
    maxHearts: number;
    heartBack?: { done: number; needed: number } | null;
    /** Opens the rail's other panels; without it there is no More button. */
    onmore?: () => void;
  } = $props();

  // Mounted at every width (hidden by CSS beside the rail), so it is the one place the bell rings.
  const bell = watchBell(untrack(() => ({ value, max, watch })));
  $effect(() => {
    const now = { value, max, watch };
    untrack(() => {
      if (bell(now)) sound.play('bell');
    });
  });
</script>

<!-- Below 1024px there is no rail: the Watch, the streak and the hearts sit in one quiet row above the question. -->
<div class="meta">
  <div class="bar">
    <span class="cell">
      {#if done}
        <span class="watch done"><Icon name="circle-check" size={14} />Watch complete</span>
      {:else}
        <span class="watch" use:bump={value}>Watch <b>{value}/{max}</b></span>
      {/if}
    </span>
    <span class="cell"><span class="streak"><Icon name="flame" size={14} /><b>{streak}</b> {streak === 1 ? 'day' : 'days'}</span></span>
    <span class="cell"><HeartsRow {hearts} {maxHearts} {heartBack} />{#if heartBack}<span class="back">{heartBackShort(heartBack)}</span>{/if}</span>
    {#if onmore}
      <button type="button" class="cell more" aria-label="More stats" aria-haspopup="dialog" onclick={onmore}>
        <Icon name="chevron-down" size={16} />
      </button>
    {/if}
  </div>
</div>

<style>
  /* Touch has no tooltip, so the count toward the next heart sits beside the hearts. */
  .back {
    margin-left: 6px;
    color: var(--io-parchment-muted);
    font-size: 12px;
  }
  .meta {
    flex: none;
    box-sizing: border-box;
    /* Same width as the question column, so the two left edges line up between 40rem and 64rem. */
    width: 100%;
    max-width: 1056px;
    margin: 0 auto;
    padding: 8px 28px;
    color: var(--io-parchment-muted);
    font: 400 12px/1.2 var(--io-font-ui);
  }
  /* One grouped strip: three equal cells split by hairlines, so the figures read as a set. */
  .bar {
    display: flex;
    align-items: stretch;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel);
  }
  .cell {
    display: flex;
    flex: 1 1 0;
    align-items: center;
    justify-content: center;
    min-width: 0;
    padding: 7px 8px;
  }
  .cell + .cell {
    border-left: 1px solid var(--border);
  }
  .more {
    flex: none;
    min-width: 44px;
    min-height: 0;
    padding: 0 12px;
    border-width: 0 0 0 1px;
    border-radius: 0 8px 8px 0;
    background: none;
    color: var(--io-gold);
  }
  .more:hover:not(:disabled) {
    background: var(--io-bg);
    color: var(--io-parchment);
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
  @media (min-width: 64rem) {
    .meta {
      display: none;
    }
  }
  @media (max-width: 40rem) {
    .meta {
      padding: 12px 16px 8px;
    }
  }
</style>
