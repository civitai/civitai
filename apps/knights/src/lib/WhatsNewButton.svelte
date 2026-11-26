<script lang="ts">
  import Icon from './Icon.svelte';
  import { updatesView } from './updates.svelte';

  // The layout owns the dialog; this button only opens it. It wears a dot while an entry is unseen.
  const updates = updatesView();
  let unseen = $derived(updates?.unseen ?? 0);
</script>

{#if updates}
  <button
    type="button"
    class="whats-new-button"
    aria-label={unseen > 0 ? `What's new, ${unseen} not yet seen` : "What's new"}
    title="What's new"
    onclick={updates.show}
  >
    <Icon name="scroll-text" size={18} />
    {#if unseen > 0}<span class="dot" aria-hidden="true"></span>{/if}
  </button>
{/if}

<style>
  .whats-new-button {
    position: relative;
    display: grid;
    flex: none;
    place-items: center;
    width: 36px;
    height: 36px;
    min-height: 0;
    padding: 0;
    border: 1px solid var(--io-gold-muted);
    border-radius: 999px;
    background: var(--io-bg);
    color: var(--io-gold);
  }
  .whats-new-button:hover {
    background: var(--io-surface);
  }
  .dot {
    position: absolute;
    top: -1px;
    right: -1px;
    width: 9px;
    height: 9px;
    border: 2px solid var(--io-surface);
    border-radius: 50%;
    background: var(--io-crimson);
    box-sizing: content-box;
  }
</style>
