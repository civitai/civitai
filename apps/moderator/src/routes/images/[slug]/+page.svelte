<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import ImageReviewGrid from '$lib/components/ImageReviewGrid.svelte';
  import PromptHighlight from '$lib/components/PromptHighlight.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // Payload is discriminated by `kind`; each kind carries its own item shape.
  type HighlightItem = Extract<PageData, { kind: 'review-highlight' }>['items'][number];
  type ReviewItem = Extract<PageData, { kind: 'review' }>['items'][number];
  type ReportedItem = Extract<PageData, { kind: 'reported' }>['items'][number];
  type AppealItem = Extract<PageData, { kind: 'appeal' }>['items'][number];

  const gridProps = $derived({
    title: data.title,
    level: data.level,
    civitaiUrl: data.civitaiUrl,
    nextCursor: data.nextCursor,
  });

  const fmt = (d: Date | string | null) => (d ? new Date(d).toLocaleDateString() : '');

  // Report.details is free-form JSON; surface a `comment` if the reporter left one.
  const comment = (details: unknown): string | null => {
    const c = (details as { comment?: unknown } | null)?.comment;
    return typeof c === 'string' && c.trim() ? c : null;
  };
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

{#snippet poi(_item: ReviewItem)}
  <Badge class="w-fit bg-orange-500/15 text-orange-400">POI</Badge>
{/snippet}

{#snippet tag(item: ReviewItem)}
  <div class="flex flex-wrap gap-1">
    {#each item.reviewTags as reviewTag (reviewTag.id)}
      <Badge class="bg-violet-500/15 text-violet-400">{reviewTag.name}</Badge>
    {:else}
      <span class="text-xs text-muted-foreground">no review tags</span>
    {/each}
  </div>
{/snippet}

{#snippet newUser(item: ReviewItem)}
  <div class="flex flex-wrap gap-1">
    <Badge class="bg-sky-500/15 text-sky-400">New user</Badge>
    {#if item.blockedFor}<Badge class="bg-muted">{item.blockedFor}</Badge>{/if}
  </div>
{/snippet}

{#snippet modRule(item: ReviewItem)}
  <p class="text-xs text-amber-400">{item.ruleReason ?? 'Rule violation'}</p>
{/snippet}

{#snippet csam(_item: ReviewItem)}
  <Badge class="w-fit bg-rose-600/20 font-semibold text-rose-500">CSAM — flagged for review</Badge>
{/snippet}

{#snippet reported(item: ReportedItem)}
  <div class="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
    <div class="flex items-center justify-between gap-2">
      <span class="font-semibold text-amber-400">{item.report.reason}</span>
      {#if item.report.count > 1}
        <span class="shrink-0 text-muted-foreground">+{item.report.count} others</span>
      {/if}
    </div>
    <div class="mt-0.5 text-muted-foreground">
      by
      <a
        href={`${data.civitaiUrl}/user/${item.report.username}`}
        target="_blank"
        rel="noreferrer"
        class="hover:text-foreground">{item.report.username ?? '[deleted]'}</a
      >
      · {new Date(item.report.createdAt).toLocaleDateString()}
    </div>
    {#if comment(item.report.details)}
      <p class="mt-1 line-clamp-3 text-muted-foreground/90">{comment(item.report.details)}</p>
    {/if}
  </div>
{/snippet}

{#snippet appeal(item: AppealItem)}
  <div class="flex flex-col gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/5 p-2 text-xs">
    <div>
      <span class="font-semibold text-rose-400">Removed:</span>
      {item.tosReason ?? item.blockedFor ?? 'TOS violation'}
      {#if item.removedAt}
        <span class="text-muted-foreground">
          · by {item.moderatorUsername ?? 'moderator'} · {fmt(item.removedAt)}
        </span>
      {/if}
    </div>
    <div>
      <span class="font-semibold text-sky-400">Appeal:</span>
      <span class="text-muted-foreground/90">{item.appeal.message}</span>
    </div>
    <div class="text-muted-foreground">
      by
      <a
        href={`${data.civitaiUrl}/user/${item.appeal.username}`}
        target="_blank"
        rel="noreferrer"
        class="hover:text-foreground">{item.appeal.username ?? '[deleted]'}</a
      >
      · {fmt(item.appeal.createdAt)}
    </div>
    {#if item.reports.length > 0}
      <div class="text-muted-foreground">
        Triggered by: {item.reports.map((r) => r.reason).join(', ')}
      </div>
    {/if}
  </div>
{/snippet}

{#if data.kind === 'review-highlight'}
  <ImageReviewGrid {...gridProps} items={data.items}>
    {#snippet detail(item)}
      {#if data.view === 'minor'}
        {@render minor(item)}
      {:else}
        {@render remixSource(item)}
      {/if}
    {/snippet}
  </ImageReviewGrid>
{:else if data.kind === 'review'}
  {@const detailFor = { poi, tag, newUser, modRule, csam }[data.view]}
  <ImageReviewGrid {...gridProps} items={data.items}>
    {#snippet detail(item)}
      {@render detailFor(item)}
    {/snippet}
  </ImageReviewGrid>
{:else if data.kind === 'reported'}
  <ImageReviewGrid {...gridProps} items={data.items} keyOf={(item) => item.report.id}>
    {#snippet detail(item)}
      {@render reported(item)}
    {/snippet}
  </ImageReviewGrid>
{:else}
  <ImageReviewGrid {...gridProps} items={data.items}>
    {#snippet detail(item)}
      {@render appeal(item)}
    {/snippet}
  </ImageReviewGrid>
{/if}
