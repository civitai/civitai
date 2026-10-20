<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { num } from '$lib/format';
  import { clipList } from '$lib/minor-flags/appeal-row';
  import {
    filesText,
    ratingText,
    versionsText,
    type ModelFlagDetail,
  } from '$lib/minor-flags/model-detail';
  import FactRow from '$lib/components/minor-flags/FactRow.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';

  let {
    row,
    detail,
  }: {
    row: {
      modelType: string;
      baseModel: string | null;
      tags: string[];
      tagCount: number;
      trainedWords: string[];
      trainedWordCount: number;
    };
    detail: Promise<ModelFlagDetail>;
  } = $props();

  const words = $derived(clipList(row.trainedWords, 8, row.trainedWordCount));
</script>

{#snippet loaded(text: (d: ModelFlagDetail) => string)}
  {#await detail}<span class="text-dark-2">…</span>{:then d}{text(d)}{:catch}<span
      class="text-dark-2">could not load</span
    >{/await}
{/snippet}

<TriageCard dense title="Model">
  <dl class="m-0 space-y-2">
    <FactRow label="Type">{row.modelType}{row.baseModel ? ` · ${row.baseModel}` : ''}</FactRow>
    <FactRow label="Versions">
      {@render loaded((d) => versionsText(d.versionCount, d.latestPublishedAt))}
    </FactRow>
    <FactRow label="Rating">{@render loaded((d) => ratingText(d.nsfwLevel, d.ratingLocked))}</FactRow>
    <FactRow label="Downloads">
      {@render loaded((d) =>
        d.downloads === null
          ? 'no metrics yet'
          : `${num(d.downloads)} · ${num(d.generations ?? 0)} generations`
      )}
    </FactRow>
    <FactRow label="Files">{@render loaded((d) => filesText(d.mainFile))}</FactRow>
    {#if words.shown.length}
      <FactRow label="Trigger words">
        <span class="flex flex-wrap items-center gap-1.5">
          {#each words.shown as word, i (i)}
            <Badge variant="outline" class="h-5 max-w-56 px-2 text-xs">
              <span class="truncate">{word}</span>
            </Badge>
          {/each}
          {#if words.more}<span class="text-dark-2">+{words.more} more</span>{/if}
        </span>
      </FactRow>
    {/if}
  </dl>
</TriageCard>
