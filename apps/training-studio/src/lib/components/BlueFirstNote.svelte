<script lang="ts">
  import { buzzMode } from '$lib/buzz-mode.svelte';

  let { class: className = '' }: { class?: string } = $props();
</script>

<!-- The charge-order note rendered beside prices (the orchestrator is charged ['blue', mode]),
     shared so Select and Review can never contradict each other. -->
<p class="font-mono text-xs text-dark-2 {className}">
  Paid with <span class="text-blue-400">Blue</span> first, then your
  <span class="capitalize text-buzz">{buzzMode.value}</span>
  Buzz{buzzMode.locked ? '.' : ' — switch in the top bar.'}
</p>
