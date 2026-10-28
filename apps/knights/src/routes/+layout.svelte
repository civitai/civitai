<script lang="ts">
  import '../global.css';

  let { children }: { children: import('svelte').Snippet } = $props();
</script>

<main>
  {@render children()}
</main>

<style>
  main {
    max-width: 48rem;
    margin: 0 auto;
    padding: 3rem 1.5rem;
  }
</style>
