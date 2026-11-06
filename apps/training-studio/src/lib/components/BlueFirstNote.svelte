<script lang="ts">
  import { buzzMode } from '$lib/buzz-mode.svelte';

  let { class: className = '' }: { class?: string } = $props();
</script>

<!-- The charge-order note rendered beside prices (the orchestrator is charged `buzzMode.currencies`),
     shared so Select and Review can never contradict each other. -->
<p class="font-mono text-xs text-dark-2 {className}">
  {#if buzzMode.blueFirst}
    Paid with <span class="text-blue-400">Blue</span> first, then your
  {:else}
    Paid with your
  {/if}
  <span class="capitalize text-buzz">{buzzMode.value}</span>
  Buzz{buzzMode.blueFirst ? '' : ' only'}{buzzMode.locked ? '.' : ' — switch in the top bar.'}
</p>
