<script lang="ts">
  import type { Snippet } from 'svelte';

  /** One key/value row of a facts card: a fixed-width muted key, the value beside it. */
  let { label, children }: { label: string; children: Snippet } = $props();
</script>

<div class="flex gap-3 text-xs">
  <dt class="w-[90px] shrink-0 text-dark-2">{label}</dt>
  <dd class="m-0 min-w-0 flex-1 leading-[1.45] text-dark-0">{@render children()}</dd>
</div>
