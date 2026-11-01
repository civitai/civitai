<script lang="ts">
  import { cn } from '@civitai/ui/utils.js';
  import HighlightedText from '$lib/components/restrictions/HighlightedText.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { quotedPhrases } from '$lib/quoted-phrases';
  import type { ScannedText } from '$lib/server/rating-reviews.service';

  let {
    text,
    entityLabel,
    reason,
  }: { text: ScannedText; entityLabel: string; reason?: string | null } = $props();

  const phrases = $derived(reason ? quotedPhrases(reason) : []);

  let box = $state<HTMLElement | null>(null);
  let open = $state(false);
  let overflows = $state(false);

  // The toggle only shows when the collapsed card clips something.
  $effect(() => {
    if (box && !open) overflows = box.scrollHeight > box.clientHeight + 1;
  });
</script>

<TriageCard title="Scanned text" dense>
  <div
    bind:this={box}
    class={cn('space-y-2 overflow-hidden text-dark-0', !open && 'max-h-40')}
  >
    {#each text.fields as field, i (i)}
      <div>
        <p class="m-0 text-[11px] font-semibold text-dark-2">{field.heading}</p>
        <HighlightedText
          class="m-0 text-[13px] leading-[inherit] wrap-anywhere"
          text={field.text}
          highlight={phrases}
        />
      </div>
    {/each}
  </div>
  {#if overflows || open}
    <button
      type="button"
      class="mt-2 cursor-pointer border-0 bg-transparent p-0 text-xs text-blue-300 hover:underline"
      aria-expanded={open}
      onclick={() => (open = !open)}
    >
      {open ? 'Show less' : 'Show all'}
    </button>
  {/if}
  {#if text.truncated}
    <p class="m-0 mt-2 text-xs text-dark-2">Long text shortened; open the {entityLabel} for the rest.</p>
  {/if}
</TriageCard>
