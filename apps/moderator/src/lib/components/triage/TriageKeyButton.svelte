<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Button, type ButtonProps } from '@civitai/ui/components/ui/button/index.js';
  import { Kbd } from '@civitai/ui/components/ui/kbd/index.js';
  import { cn } from '@civitai/ui/utils.js';

  /** A decision button with its key on the left; the primary one is red, the others outline. */
  let {
    key,
    primary = false,
    pressed,
    children,
    ...rest
  }: {
    key: number;
    primary?: boolean;
    /** The decision is picked and waits for its reason. */
    pressed?: boolean;
    children: Snippet;
  } & Omit<ButtonProps, 'children' | 'size'> = $props();
</script>

<Button
  size="lg"
  variant={primary ? 'default' : 'outline'}
  aria-pressed={pressed}
  class={cn(
    'h-11 gap-2.5 px-4 text-base',
    primary && 'bg-red-600 text-white hover:bg-red-700',
    pressed && 'ring-2 ring-white/50'
  )}
  {...rest}
>
  <Kbd class={primary ? 'bg-black/30 text-white' : 'bg-dark-5 text-white'}>{key}</Kbd>
  {@render children()}
</Button>
