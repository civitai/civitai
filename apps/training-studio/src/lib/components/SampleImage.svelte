<script lang="ts">
  import { cn } from '@civitai/ui/utils.js';

  let {
    url,
    alt = 'training sample',
    class: className = '',
  }: { url: string | null; alt?: string; class?: string } = $props();
</script>

{#if url}
  <img
    src={url}
    {alt}
    loading="lazy"
    class={cn('aspect-square w-full rounded object-cover ring-1 ring-inset ring-dark-4/60', className)}
  />
{:else}
  <div
    class={cn(
      'grid aspect-square w-full place-items-center rounded border border-dashed border-dark-4 bg-dark-7 font-mono text-[10px] text-dark-2',
      className
    )}
  >
    no image
  </div>
{/if}
