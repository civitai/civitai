<script lang="ts">
  import { cn } from '@civitai/ui/utils.js';

  let { sides }: { sides: { title: string; system: string | null }[] } = $props();
</script>

<details class="rounded-xl border border-dark-4 bg-dark-6 p-3">
  <summary class="text-xs text-dark-2">Show prompt sent</summary>
  <div class={cn('mt-2 grid gap-3', sides.length === 2 && 'xl:grid-cols-2')}>
    {#each sides as side (side.title)}
      <div class="min-w-0">
        <p class="text-xs font-semibold text-dark-2">{side.title}</p>
        {#if side.system}
          <pre
            class="mt-1 max-h-96 overflow-auto rounded-md border border-dark-4 bg-dark-7 p-2 text-xs leading-5 whitespace-pre-wrap text-dark-0">{side.system}</pre>
        {:else}
          <p class="mt-1 text-xs text-dark-2">Not available: nothing was scanned on this side.</p>
        {/if}
      </div>
    {/each}
  </div>
</details>
