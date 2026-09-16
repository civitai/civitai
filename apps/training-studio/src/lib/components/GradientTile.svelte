<script module lang="ts">
  // Placeholder "thumbnails" — demo only, until real dataset images / epoch samples land. When they
  // do, this component is the single seam to swap (dataset blob / orchestrator sample) for the gradient.
  const GRADS = [
    '135deg,#1971c2,#0d2440', '135deg,#f5a623,#3a2606', '135deg,#9b7dff,#241a45', '135deg,#40c057,#0a2413',
    '135deg,#e64980,#3a0f22', '135deg,#22b8cf,#082d33', '135deg,#7048e8,#1a1040', '135deg,#fd7e14,#331704',
    '135deg,#12b886,#052b20', '135deg,#4a9ff5,#0a2036', '135deg,#f06595,#340f22', '135deg,#845ef7,#1c1240',
  ];
  export const grad = (i: number): string =>
    `linear-gradient(${GRADS[((i % GRADS.length) + GRADS.length) % GRADS.length]})`;
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from '@civitai/ui/utils.js';

  let {
    index,
    class: className = '',
    children,
  }: { index: number; class?: string; children?: Snippet } = $props();
</script>

<div class={cn('aspect-square rounded-md', className)} style={`background:${grad(index)}`}>
  {@render children?.()}
</div>
