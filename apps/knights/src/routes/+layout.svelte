<script lang="ts">
  import '../global.css';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();
</script>

<nav aria-label="Site">
  <a href={data.civitaiUrl}>Back to Civitai</a>
  <a href="/logout" data-sveltekit-reload>Sign out</a>
</nav>

<main>
  {@render children()}
</main>

<style>
  nav {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
    max-width: 48rem;
    margin: 0 auto;
    padding: 0.75rem 1.5rem 0;
    font-size: 0.85rem;
  }
  nav a {
    color: var(--muted);
  }
  main {
    max-width: 48rem;
    margin: 0 auto;
    padding: 1.5rem 1.5rem 3rem;
  }
</style>
