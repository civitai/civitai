<script lang="ts">
  import HeartsRow from './HeartsRow.svelte';
  import Icon from './Icon.svelte';

  let {
    value,
    max,
    streak,
    hearts,
    maxHearts,
  }: { value: number; max: number; streak: number; hearts: number; maxHearts: number } = $props();
</script>

<!-- Below 1200px there is no rail: the Watch, the streak and the hearts sit in one quiet row above the question. -->
<div class="meta">
  <span class="watch">Watch <b>{value}/{max}</b></span>
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
