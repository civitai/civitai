<script lang="ts">
  import { BLOCK_REASONS, type BlockReason } from '$lib/block-reasons';
  import { modal } from '$lib/modal';

  let { onpick, oncancel }: { onpick: (reason: BlockReason) => void; oncancel: () => void } = $props();
</script>

<!-- On a wide screen this covers the answer row in place; at 640px and under it is a bottom sheet over a dimmed page. -->
<div class="backdrop" role="presentation" onclick={(event) => event.target === event.currentTarget && oncancel()}>
  <div class="panel" role="dialog" aria-modal="true" aria-labelledby="block-reason-title" tabindex="-1" use:modal={{ onescape: oncancel }}>
    <p id="block-reason-title" class="title">Why is it blocked?</p>
    <div class="options">
      {#each BLOCK_REASONS as reason, index (reason.value)}
        <button type="button" class="reason" onclick={() => onpick(reason.value)} data-autofocus={index === 0 ? '' : undefined}>
          <kbd class="key" aria-hidden="true">{index + 1}</kbd>
          <span>{reason.label}</span>
        </button>
      {/each}
    </div>
    <button type="button" class="cancel" onclick={oncancel}>Cancel<span class="esc">&nbsp;·&nbsp;Esc</span></button>
  </div>
</div>

<style>
  .backdrop {
    position: absolute;
    inset: 0;
    z-index: 10;
    display: flex;
  }
  .panel {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: 12px;
    min-width: 0;
    padding: 0 8px;
    border: 1px solid var(--io-crimson);
    border-radius: 6px;
    background: var(--io-surface);
  }
  .title {
    flex: none;
    margin: 0;
    color: var(--io-crimson-text);
    font: 600 11px/1.2 var(--io-font-ui);
    letter-spacing: 2px;
    text-transform: uppercase;
  }
  .options {
    display: flex;
    flex: 1 1 auto;
    gap: 8px;
    min-width: 0;
  }
  .reason {
    display: flex;
    flex: 1 1 0;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-width: 0;
    height: 32px;
    padding: 0 8px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 6px;
    background: var(--io-bg);
    color: var(--io-parchment);
    font: 700 13px/1 var(--io-font-ui);
  }
  .reason:hover,
  .reason:focus-visible {
    border-color: var(--io-gold);
  }
  .key {
    display: grid;
    flex: none;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 6px;
    background: var(--io-surface);
    color: var(--io-parchment-muted);
    font: 700 12px/1 var(--io-font-ui);
  }
  .cancel {
    flex: none;
    min-height: 0;
    padding: 4px 0;
    border: 0;
    background: none;
    color: var(--io-parchment-muted);
    font: 400 12px/1.2 var(--io-font-ui);
    white-space: nowrap;
  }
  .cancel:hover {
    background: none;
    color: var(--io-parchment);
  }

  @media (max-width: 40rem) {
    .backdrop {
      position: fixed;
      z-index: 30;
      align-items: flex-end;
      background: rgb(14 12 9 / 0.82);
    }
    .panel {
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
      padding: 16px 16px max(16px, env(safe-area-inset-bottom));
      border-width: 1px 0 0;
      border-radius: 12px 12px 0 0;
    }
    .options {
      flex-direction: column;
    }
    .reason {
      flex: none;
      justify-content: flex-start;
      height: 48px;
      font-size: 15px;
    }
    .cancel {
      min-height: 44px;
    }
    .esc {
      display: none;
    }
  }
  @media (max-width: 40rem), (hover: none) {
    .key {
      display: none;
    }
  }
</style>
