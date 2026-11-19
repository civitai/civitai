<script lang="ts">
  import '$lib/overlay.css';

  let { ready, oncontinue }: { ready: boolean; oncontinue: () => void } = $props();
  let button = $state<HTMLButtonElement>();

  $effect(() => {
    if (ready) button?.focus({ preventScroll: true });
  });
</script>

<!-- Over the image stage only: the answer row stays where it is, and is locked by the page while this is up. -->
<div class="settled" role="alertdialog" aria-labelledby="settled-title" aria-describedby="settled-body">
  <div class="panel">
    <p id="settled-title" class="ov-eyebrow">Settled by the Order</p>
    <p id="settled-body" class="body">Its verdict came in before yours. There is nothing to earn here.</p>
    <button type="button" class="ov-ack" bind:this={button} disabled={!ready} onclick={oncontinue}>
      Next image<span class="key">&nbsp;·&nbsp;Enter</span>
    </button>
  </div>
</div>

<style>
  .settled {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    border-radius: 12px;
    background: rgb(14 12 9 / 0.72);
    animation: ov-fade var(--motion-base) var(--ease-out-quart);
  }
  .panel {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    max-width: 22rem;
    padding: 20px 24px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 8px;
    background: var(--io-surface);
    text-align: center;
  }
  .body {
    margin: 0;
    color: var(--io-parchment);
    font: 400 16px/1.4 var(--io-font-body);
  }
  .ov-ack:disabled {
    opacity: 0.5;
  }
  .key {
    color: var(--io-parchment-muted);
  }
  @media (prefers-reduced-motion: reduce) {
    .settled {
      animation: none;
    }
  }
  @media (max-width: 40rem) {
    .settled {
      border-radius: 8px;
    }
    .key {
      display: none;
    }
  }
</style>
