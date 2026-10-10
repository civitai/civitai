<script lang="ts">
  import { cn } from '@civitai/ui/utils.js';

  let {
    items,
    active,
    class: className,
  }: {
    items: readonly { value: string; label: string; href: string }[];
    active: string | undefined;
    class?: string;
  } = $props();
</script>

<div class={cn('flex flex-wrap gap-1', className)}>
  {#each items as item (item.value)}
    <a
      href={item.href}
      class={cn(
        'rounded-md px-3 py-1 text-sm',
        item.value === active ? 'bg-dark-5 text-white' : 'text-dark-2 hover:bg-dark-6'
      )}
    >
      {item.label}
    </a>
  {/each}
</div>
