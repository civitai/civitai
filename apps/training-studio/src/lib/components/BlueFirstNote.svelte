<script lang="ts">
  import { buzzMode } from '$lib/buzz-mode.svelte';
  import BlueFirstToggle from './BlueFirstToggle.svelte';

  let { class: className = '' }: { class?: string } = $props();
</script>

<!-- The charge-order note rendered beside prices (the orchestrator is charged `buzzMode.currencies`),
     shared so every spend site can never contradict another. The embed has no Buzz header, so when the
     host locks the paid account this note carries the Blue-first switch itself. -->
<div class={className}>
  <p class="font-mono text-xs text-dark-2">
    {#if buzzMode.blueFirst}
      Paid with <span class="text-blue-400">Blue</span> first, then your
    {:else}
      Paid with your
    {/if}
    <span class="capitalize text-buzz">{buzzMode.value}</span>
    Buzz{buzzMode.blueFirst ? '' : ' only'}{buzzMode.locked ? '.' : ' — switch in the top bar.'}
  </p>
  {#if buzzMode.locked}
    <BlueFirstToggle class="mt-1.5" />
  {/if}
</div>
