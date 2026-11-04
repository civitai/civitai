<script lang="ts">
  import Icon from '$lib/Icon.svelte';
</script>

<!-- The way out of every secondary page: back to judging, or to the home screen. -->
<nav class="page-nav" aria-label="Back">
  <a href="/play" data-sveltekit-preload-data="off"><Icon name="arrow-left" size={14} />Play</a>
  <a href="/">Home</a>
</nav>

<style>
  .page-nav {
    display: flex;
    align-items: center;
    gap: 1.25rem;
    margin: 0 0 1rem;
    font: 400 13px/1.2 var(--io-font-ui);
  }
  a {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    color: var(--io-parchment-muted);
    text-decoration: none;
  }
  a:hover {
    color: var(--io-parchment);
  }
</style>
