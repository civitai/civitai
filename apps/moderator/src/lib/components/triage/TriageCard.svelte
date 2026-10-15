<script lang="ts">
  import type { Snippet } from 'svelte';

  let { title, children }: { title: string; children: Snippet } = $props();
</script>

<section class="rounded-xl border border-dark-4 bg-dark-7 p-5">
  <h3 class="m-0 mb-3 text-sm font-semibold tracking-wide text-white uppercase">{title}</h3>
  {@render children()}
</section>
