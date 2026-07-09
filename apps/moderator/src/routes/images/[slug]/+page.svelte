<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import ImageReviewGrid from '$lib/components/ImageReviewGrid.svelte';
  import PromptHighlight from '$lib/components/PromptHighlight.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // The payload is view-discriminated: only minor/remixSource items carry `promptHighlight`.
  type AnyItem = PageData['items'][number];
  type HighlightItem = Extract<AnyItem, { promptHighlight: unknown }>;
  type BaseItem = Exclude<AnyItem, { promptHighlight: unknown }>;

  const gridProps = $derived({
    title: data.title,
    level: data.level,
    civitaiUrl: data.civitaiUrl,
    nextCursor: data.nextCursor,
  });
</script>

{#snippet minor(item: HighlightItem)}
  <div class="flex flex-col gap-1.5">
    <div class="flex flex-wrap gap-1">
      <Badge
        class={item.minor ? 'bg-rose-500/15 text-rose-500' : 'bg-emerald-500/15 text-emerald-500'}
      >
        {item.minor ? 'Minor' : 'Not minor'}
      </Badge>
      {#if item.acceptableMinor}
        <Badge class="bg-pink-500/15 text-pink-400">Acceptable minor</Badge>
      {/if}
    </div>
    {#if item.promptHighlight.includesInappropriate}
      <PromptHighlight result={item.promptHighlight} />
    {/if}
  </div>
{/snippet}

{#snippet remixSource(item: HighlightItem)}
  <div class="flex flex-col gap-1.5">
    <Badge class="w-fit bg-fuchsia-500/15 text-fuchsia-400">Remix source — prompt flagged</Badge>
    <PromptHighlight result={item.promptHighlight} />
  </div>
{/snippet}

{#snippet poi(_item: BaseItem)}
  <Badge class="w-fit bg-orange-500/15 text-orange-400">POI</Badge>
{/snippet}

{#snippet tag(item: BaseItem)}
  <div class="flex flex-wrap gap-1">
    {#each item.reviewTags as reviewTag (reviewTag.id)}
      <Badge class="bg-violet-500/15 text-violet-400">{reviewTag.name}</Badge>
    {:else}
      <span class="text-xs text-muted-foreground">no review tags</span>
    {/each}
  </div>
{/snippet}

{#snippet newUser(item: BaseItem)}
  <div class="flex flex-wrap gap-1">
    <Badge class="bg-sky-500/15 text-sky-400">New user</Badge>
    {#if item.blockedFor}<Badge class="bg-muted">{item.blockedFor}</Badge>{/if}
  </div>
{/snippet}

{#snippet modRule(item: BaseItem)}
  <p class="text-xs text-amber-400">{item.ruleReason ?? 'Rule violation'}</p>
{/snippet}

{#if data.view === 'minor' || data.view === 'remixSource'}
  <ImageReviewGrid {...gridProps} items={data.items}>
    {#snippet detail(item)}
      {#if data.view === 'minor'}
        {@render minor(item)}
      {:else}
        {@render remixSource(item)}
      {/if}
    {/snippet}
  </ImageReviewGrid>
{:else}
  {@const detailFor = { poi, tag, newUser, modRule }[data.view]}
  <ImageReviewGrid {...gridProps} items={data.items}>
    {#snippet detail(item)}
      {@render detailFor(item)}
    {/snippet}
  </ImageReviewGrid>
{/if}
