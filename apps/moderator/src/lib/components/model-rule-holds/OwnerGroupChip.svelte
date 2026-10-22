<script lang="ts">
  import type { ComponentProps, Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';

  let {
    href,
    title,
    tone = 'blue',
    children,
  }: {
    href: string;
    title: string;
    tone?: ComponentProps<typeof MetaChip>['tone'];
    children: Snippet;
  } = $props();

  // Sits inside a row's own link, which a nested anchor cannot: it filters the queue instead of selecting the row.
  const go = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    void goto(href);
  };
</script>

<span
  role="link"
  tabindex="0"
  {title}
  class="cursor-pointer hover:brightness-125"
  onclick={go}
  onkeydown={(e) => {
    if (e.key === 'Enter') go(e);
  }}
>
  <MetaChip {tone}>{@render children()}</MetaChip>
</span>
