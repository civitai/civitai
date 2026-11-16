<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import Icon from '$lib/Icon.svelte';
  import { modal } from '$lib/modal';
  import '$lib/overlay.css';
  import PlayRail from './PlayRail.svelte';

  let {
    status,
    daily,
    rail,
    ladder,
    onclose,
  }: Omit<ComponentProps<typeof PlayRail>, 'sheet'> & { onclose: () => void } = $props();

  // From 64rem the rail itself is on the page, so a sheet left open by a resize or rotation closes.
  $effect(() => {
    const desktop = window.matchMedia('(min-width: 64rem)');
    const onchange = () => {
      if (desktop.matches) onclose();
    };
    onchange();
    desktop.addEventListener('change', onchange);
    return () => desktop.removeEventListener('change', onchange);
  });
</script>

<!-- Below 64rem there is no rail: the same panels open here, from the stats bar's More button. -->
<div
  class="ov-backdrop"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) onclose();
  }}
>
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="rail-sheet-title"
    tabindex="-1"
    use:modal={{ onescape: onclose }}
  >
    <span class="handle" aria-hidden="true"></span>
    <div class="head">
      <h2 id="rail-sheet-title">Your day in the Order</h2>
      <button type="button" class="close" aria-label="Close" onclick={onclose} data-autofocus>
        <Icon name="x" size={18} />
      </button>
    </div>
    <div class="scroll">
      <PlayRail {status} {daily} {rail} {ladder} sheet />
    </div>
  </div>
</div>

<style>
  .ov-backdrop {
    align-items: flex-end;
    padding: 0;
  }
  .dialog {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 30rem;
    max-height: 88dvh;
    border: 1px solid var(--io-gold);
    border-width: 1px 1px 0;
    border-radius: 20px 20px 0 0;
    background: var(--io-surface);
    overflow: hidden;
  }
  .handle {
    flex: none;
    width: 40px;
    height: 4px;
    margin: 12px auto 0;
    border-radius: 2px;
    background: var(--io-gold-muted);
  }
  .head {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px 4px 20px;
  }
  h2 {
    margin: 0;
    color: var(--io-parchment);
    font: 700 18px/1.2 var(--io-font-display);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .close {
    display: grid;
    place-items: center;
    width: 40px;
    min-height: 40px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--io-parchment-muted);
  }
  .close:hover:not(:disabled) {
    background: none;
    color: var(--io-parchment);
  }
  .scroll {
    flex: 1 1 auto;
    min-height: 0;
    padding-bottom: max(12px, env(safe-area-inset-bottom));
    overflow-y: auto;
  }
</style>
