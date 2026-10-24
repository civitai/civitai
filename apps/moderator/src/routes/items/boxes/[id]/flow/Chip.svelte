<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Toggle } from '@civitai/ui/components/ui/toggle/index.js';

  let {
    pressed,
    onclick,
    size = 'sm',
    children,
  }: { pressed: boolean; onclick: () => void; size?: 'sm' | 'default'; children: Snippet } = $props();
</script>

<!-- A function binding: the primitive writes `pressed` on every click, and this keeps what the parent says authoritative. -->
<Toggle {size} variant="outline" bind:pressed={() => pressed, () => onclick()}>{@render children()}</Toggle>
