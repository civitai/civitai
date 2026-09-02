<script lang="ts">
  import { cn } from '@civitai/ui/utils.js';

  let {
    urls,
    cols = 4,
    class: className = '',
  }: { urls: string[]; cols?: number; class?: string } = $props();

  const colClass: Record<number, string> = {
    2: 'grid-cols-2',
    3: 'grid-cols-3',
    4: 'grid-cols-4',
    6: 'grid-cols-6',
  };
</script>

<div class={cn('grid gap-1.5', colClass[cols] ?? 'grid-cols-4', className)}>
  {#each urls as url, i (i)}
    <img
      src={url}
      alt="training sample"
      loading="lazy"
      class="aspect-square w-full rounded object-cover ring-1 ring-inset ring-dark-4/60"
    />
  {/each}
</div>
