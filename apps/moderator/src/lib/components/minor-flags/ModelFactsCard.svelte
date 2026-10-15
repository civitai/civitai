<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { dateTime, shortAge } from '$lib/format';
  import { clipList } from '$lib/minor-flags/appeal-row';
  import TriageCard from './TriageCard.svelte';

  let {
    row,
  }: {
    row: {
      modelType: string;
      baseModel: string | null;
      modelCreatedAt: Date | string;
      tags: string[];
      tagCount: number;
      trainedWords: string[];
      trainedWordCount: number;
    };
  } = $props();

  const tags = $derived(clipList(row.tags, 12, row.tagCount));
  const words = $derived(clipList(row.trainedWords, 8, row.trainedWordCount));
</script>

<TriageCard title="Model">
  <p class="m-0 text-base text-dark-0">
    {row.modelType}{row.baseModel ? ` · ${row.baseModel}` : ''} ·
    <span title={dateTime(row.modelCreatedAt)}>uploaded {shortAge(row.modelCreatedAt)} ago</span>
  </p>
  {#if tags.shown.length}
    <div class="mt-3 flex flex-wrap items-center gap-1.5">
      <span class="text-sm text-dark-2">Tags</span>
      {#each tags.shown as tag (tag)}
        <Badge variant="secondary" class="h-6 max-w-56 px-2.5 text-sm">
          <span class="truncate">{tag}</span>
        </Badge>
      {/each}
      {#if tags.more}<span class="text-sm text-dark-2">+{tags.more} more</span>{/if}
    </div>
  {/if}
  {#if words.shown.length}
    <div class="mt-3 flex flex-wrap items-center gap-1.5">
      <span class="text-sm text-dark-2">Trigger words</span>
      {#each words.shown as word, i (i)}
        <Badge variant="outline" class="h-6 max-w-56 px-2.5 text-sm">
          <span class="truncate">{word}</span>
        </Badge>
      {/each}
      {#if words.more}<span class="text-sm text-dark-2">+{words.more} more</span>{/if}
    </div>
  {/if}
</TriageCard>
