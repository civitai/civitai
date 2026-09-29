<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { dateTime } from '$lib/format';
  import type { PageData } from './$types';

  type Result = NonNullable<PageData['result']>;

  let { flag, model }: { flag: Result['flag']; model: Result['model'] } = $props();

  // A `ModelFlag` row is what the text scan PROPOSED; the columns on `Model` are what is in force. The
  // pair is the point of this panel: a raised flag whose model column is still false is an unactioned
  // finding, and neither surface alone says that.
  const raised = $derived(
    flag
      ? (
          [
            ['POI', flag.poi, model.poi],
            ['Minor', flag.minor, model.minor],
            ['SFW only', flag.sfwOnly, model.sfwOnly],
            ['NSFW', flag.nsfw, model.nsfw],
            // No column on `Model` answers these two, so they are reported without a counterpart rather
            // than against a `false` that would read as "reviewed and rejected".
            ['Trigger words', flag.triggerWords, null],
            ['POI name', flag.poiName, null],
          ] as [string, boolean, boolean | null][]
        ).filter(([, isFlagged]) => isFlagged)
      : []
  );
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="flex flex-wrap items-baseline gap-x-3">
    <h3 class="text-sm font-semibold text-white">Content scan</h3>
    {#if flag}
      <Badge variant={flag.status === 'Pending' ? 'default' : 'secondary'}>{flag.status}</Badge>
      <span class="text-xs text-dark-2">{dateTime(flag.createdAt)}</span>
    {/if}
  </div>

  {#if !flag}
    <p class="mt-3 text-sm text-dark-2">
      No content-scan row — this model's text has never been scanned.
    </p>
  {:else if raised.length === 0}
    <p class="mt-3 text-sm text-dark-2">Scanned, nothing raised.</p>
  {:else}
    <ul class="mt-3 space-y-1 text-sm">
      {#each raised as [label, , applied] (label)}
        <li class="flex flex-wrap items-baseline gap-x-2">
          <Badge variant="destructive">{label}</Badge>
          {#if applied === null}
            <span class="text-xs text-dark-2">no corresponding model flag</span>
          {:else if applied}
            <span class="text-xs text-dark-2">set on the model</span>
          {:else}
            <span class="text-xs text-amber-300">not set on the model</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if flag?.details}
    <details class="mt-4 border-t border-dark-4 pt-4">
      <summary class="text-xs tracking-wide text-dark-2 uppercase">Scan details</summary>
      <pre class="mt-2 overflow-x-auto rounded-md bg-dark-7 p-2 text-xs text-dark-0">{JSON.stringify(
          flag.details,
          null,
          2
        )}</pre>
    </details>
  {/if}
</section>
