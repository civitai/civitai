<script lang="ts">
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { shortHash } from '$lib/minor-flags/appeal-row';

  let {
    names,
    textHash = null,
    since = null,
  }: {
    /** What the scan matched in the model's text. */
    names: readonly string[];
    /** The hash of the text the flag was raised on. */
    textHash?: string | null;
    /** Whether the newest scan read the same text; null makes no claim. */
    since?: 'unchanged' | 'changed' | null;
  } = $props();
</script>

<TriageCard dense title="Scanned text">
  <div class="space-y-2">
    {#if textHash}
      <p class="m-0 text-[11px] text-dark-2" title={textHash}>hash {shortHash(textHash)}{#if since === 'unchanged'}
          · unchanged since flag{:else if since === 'changed'}
          · <span class="text-amber-300">text changed since flag</span>{/if}
      </p>
    {/if}
    {#if names.length}
      <div class="flex flex-wrap gap-1.5">
        {#each names as name, i (i)}
          <MetaChip tone="red">{name}</MetaChip>
        {/each}
      </div>
    {/if}
  </div>
</TriageCard>
