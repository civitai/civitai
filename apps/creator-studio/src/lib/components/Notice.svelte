<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Icon as TablerIcon } from '@tabler/icons-svelte';

  let { icon: Icon, children }: { icon: TablerIcon; children: Snippet } = $props();
</script>

<div
  class="flex items-start gap-2 rounded-lg border border-dark-4 bg-dark-7 px-3 py-2 text-xs text-dark-2"
>
  <Icon size={15} class="mt-px shrink-0 text-white" />
  <p>{@render children()}</p>
</div>
