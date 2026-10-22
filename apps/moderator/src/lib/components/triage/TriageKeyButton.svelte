<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Button, type ButtonProps } from '@civitai/ui/components/ui/button/index.js';
  import { Kbd } from '@civitai/ui/components/ui/kbd/index.js';
  import { cn } from '@civitai/ui/utils.js';

  /** A decision button with its key on the left; the primary one is red, the others outline. */
  let {
    key,
    primary = false,
    tone,
    reasons = false,
    selected,
    children,
    ...rest
  }: {
    key: number;
    primary?: boolean;
    tone?: 'red' | 'blue' | 'dark-red' | 'darker-red' | 'red-outline';
    /** The decision offers reasons, so its key opens the reason list instead of submitting. */
    reasons?: boolean;
    /** Opt-in: the page keeps a selected decision, so mark it (aria-pressed and a blue border). */
    selected?: boolean;
    children: Snippet;
  } & Omit<ButtonProps, 'children' | 'size'> = $props();

  const TONE = {
    red: 'bg-red-600 hover:bg-red-700',
    blue: 'bg-blue-600 hover:bg-blue-700',
    'dark-red': 'bg-red-800 hover:bg-red-900',
    'darker-red': 'bg-red-950 hover:bg-red-900',
    'red-outline': 'border-red-500 bg-transparent text-red-300 hover:bg-red-950 dark:bg-transparent',
  } as const;
</script>

<Button
  variant={primary || (tone && tone !== 'red-outline') ? 'default' : 'outline'}
  class={cn(
    'h-8 gap-2 rounded-md px-3.5 text-[13px] font-semibold text-white',
    tone
      ? TONE[tone]
      : primary
        ? TONE.red
        : 'border-dark-4 bg-transparent dark:bg-transparent',
    selected && 'border-blue-5 dark:border-blue-5'
  )}
  aria-pressed={selected}
  data-triage-key={key}
  data-triage-reasons={reasons ? '' : undefined}
  {...rest}
>
  <Kbd class="h-[13px] min-w-0 rounded-[3px] bg-black/25 px-[5px] text-[11px] font-semibold text-white">
    {key}
  </Kbd>
  {@render children()}
</Button>
