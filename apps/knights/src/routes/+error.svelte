<script lang="ts">
  import { page } from '$app/state';
  import { copyFor } from '$lib/error-copy';
  import Icon from '$lib/Icon.svelte';

  const copy = $derived(copyFor(page.status, page.error?.message));
</script>

<svelte:head>
  <title>{copy.title} · Knights of New Order</title>
</svelte:head>

<section class="error" aria-labelledby="error-title">
  <span class="seal" aria-hidden="true"><Icon name={copy.icon} size={30} /></span>
  <p class="kicker">{copy.kicker} · {page.status}</p>
  <h1 id="error-title">{copy.title}</h1>
  <div class="rule" aria-hidden="true"><i></i></div>
  <p class="body">{copy.body}</p>
  <div class="actions">
    {#if copy.retry}
      <button type="button" class="btn primary" onclick={() => location.reload()}>
        <Icon name="rotate-ccw" size={16} />Try again
      </button>
      <a class="btn" href="/">Return to the hall</a>
    {:else}
      <a class="btn primary" href="/">Return to the hall</a>
    {/if}
  </div>
</section>

<style>
  .error {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 60vh;
    padding: 2rem 0 4rem;
    text-align: center;
  }
  .seal {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 70px;
    height: 70px;
    border: 1.5px solid var(--io-gold);
    border-radius: 50%;
    background: var(--io-surface);
    color: var(--io-gold);
  }
  .kicker {
    margin: 0.75rem 0 1.25rem;
    color: var(--io-parchment);
    font: 700 0.95rem/1 var(--io-font-display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  h1 {
    margin: 0;
    max-width: 36rem;
    color: var(--io-parchment);
    font: 700 clamp(1.6rem, 5vw, 2.5rem) / 1.15 var(--io-font-display);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .rule {
    display: flex;
    align-items: center;
    gap: 1rem;
    width: min(22rem, 80%);
    margin: 1.5rem 0;
    color: var(--io-gold);
  }
  .rule::before,
  .rule::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--io-gold-muted);
  }
  .rule i {
    width: 8px;
    height: 8px;
    border: 1px solid currentColor;
    transform: rotate(45deg);
  }
  .body {
    margin: 0;
    max-width: 32rem;
    color: var(--io-parchment-muted);
    font: 400 1.25rem/1.5 var(--io-font-body);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 1rem;
    margin-top: 1.75rem;
  }
  @media (max-width: 40rem) {
    .actions {
      flex-direction: column;
      align-self: stretch;
    }
  }
</style>
