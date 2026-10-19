<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Button, type ButtonProps } from '@civitai/ui/components/ui/button/index.js';
  import { Kbd } from '@civitai/ui/components/ui/kbd/index.js';
  import { cn } from '@civitai/ui/utils.js';

  /** A decision button with its key on the left; the primary one is red, the others outline. */
  let {
    key,
    primary = false,
    children,
    ...rest
  }: {
    key: number;
    primary?: boolean;
    children: Snippet;
  } & Omit<ButtonProps, 'children' | 'size'> = $props();
</script>

<Button
  variant={primary ? 'default' : 'outline'}
  class={cn(
    'h-8 gap-2 rounded-md px-3.5 text-[13px] font-semibold text-white',
    primary ? 'bg-red-600 hover:bg-red-700' : 'border-dark-4 bg-transparent dark:bg-transparent'
  )}
  data-triage-key={key}
  {...rest}
>
  <Kbd class="h-[13px] min-w-0 rounded-[3px] bg-black/25 px-[5px] text-[11px] font-semibold text-white">
    {key}
  </Kbd>
  {@render children()}
</Button>
