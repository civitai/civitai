<script lang="ts">
  import {
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandLinkItem,
    CommandList,
  } from '@civitai/ui/components/ui/command/index.js';
  import { switcherEntries } from '$lib/nav-links';
  import type { NavLink } from '$lib/server/access';

  let { nav, civitaiUrl }: { nav: NavLink[]; civitaiUrl: string } = $props();

  let open = $state(false);
  const entries = $derived(switcherEntries(nav, civitaiUrl));

  function onkeydown(event: KeyboardEvent) {
    if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return;
    if (event.altKey || event.shiftKey) return;
    event.preventDefault();
    open = !open;
  }
</script>

<svelte:window {onkeydown} />

<CommandDialog bind:open title="Go to page" description="Search for a page to open">
  <CommandInput placeholder="Go to page…" />
  <CommandList>
    <CommandEmpty>No matching page.</CommandEmpty>
    <CommandGroup>
      {#each entries as entry (entry.href + entry.label)}
        <CommandLinkItem
          href={entry.href}
          value={entry.label}
          target={entry.external ? '_blank' : undefined}
          rel={entry.external ? 'noreferrer' : undefined}
          onSelect={() => (open = false)}
        >
          {entry.label}{entry.external ? ' ↗' : ''}
        </CommandLinkItem>
      {/each}
    </CommandGroup>
  </CommandList>
</CommandDialog>
