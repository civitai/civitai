<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { IconExternalLink } from '@tabler/icons-svelte';
  import { Tabs, TabsList, TabsTrigger } from '@civitai/ui/components/ui/tabs/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import {
    Pagination,
    PaginationContent,
    PaginationEllipsis,
    PaginationItem,
    PaginationLink,
    PaginationNext,
    PaginationPrevious,
  } from '@civitai/ui/components/ui/pagination/index.js';
  import EdgeImage from '$lib/components/EdgeImage.svelte';
  import { articleUrl, userUrl } from '$lib/articles';
  import {
    ratingReviewStatusFilters,
    ratingReviewStatusBadge,
  } from '$lib/article-rating-review';
  import { browsingLevels, getBrowsingLevelLabel } from '$lib/browsing-levels';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const total = $derived(data.counts[data.status] ?? 0);
  const totalPages = $derived(Math.max(1, Math.ceil(total / data.limit)));
  const fmtDate = (d: Date | null) => (d ? new Date(d).toLocaleString() : '—');

  function urlWith(params: Record<string, string | number | null>) {
    const url = new URL(page.url);
    for (const [k, v] of Object.entries(params)) {
      if (v === null) url.searchParams.delete(k);
      else url.searchParams.set(k, String(v));
    }
    return url.pathname + url.search;
  }
</script>

<header class="page-header">
  <h1>Article Rating Review</h1>
  <div class="mt-1 flex flex-wrap gap-2">
    <Badge class={ratingReviewStatusBadge.Pending.class}>{data.counts.Pending} pending</Badge>
    <Badge class={ratingReviewStatusBadge.Actioned.class}>{data.counts.Actioned} approved</Badge>
    <Badge class={ratingReviewStatusBadge.Unactioned.class}>{data.counts.Unactioned} rejected</Badge>
  </div>
</header>

{#if form?.error}
  <div class="mb-4 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300">
    {form.error}
  </div>
{/if}

<Tabs
  value={data.status}
  onValueChange={(v) => v && goto(urlWith({ status: v, page: 1 }))}
  class="mb-4"
>
  <TabsList>
    {#each ratingReviewStatusFilters as f (f.value)}
      <TabsTrigger value={f.value}>{f.label}</TabsTrigger>
    {/each}
  </TabsList>
</Tabs>

{#if data.items.length === 0}
  <div class="placeholder">No reviews in this bucket.</div>
{:else}
  <div class="flex flex-col gap-3">
    {#each data.items as review (review.id)}
      {@const article = review.article}
      <div class="flex gap-4 rounded-xl border p-3">
        <div class="size-28 shrink-0 overflow-hidden rounded-lg bg-muted">
          {#if article.coverUrl}
            <EdgeImage
              src={article.coverUrl}
              width={112}
              alt={article.title}
              class="size-full object-cover"
            />
          {/if}
        </div>

        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <a
              href={articleUrl(data.civitaiUrl, article.id)}
              target="_blank"
              rel="noreferrer"
              class="truncate font-semibold"
            >
              {article.title}
            </a>
            <a
              href={articleUrl(data.civitaiUrl, article.id)}
              target="_blank"
              rel="noreferrer"
              class="text-muted-foreground"
            >
              <IconExternalLink size={14} />
            </a>
            {#if ratingReviewStatusBadge[review.status]}
              <Badge class={ratingReviewStatusBadge[review.status].class}>
                {ratingReviewStatusBadge[review.status].label}
              </Badge>
            {/if}
            <div class="ml-auto flex items-center gap-2 text-sm">
              {#if review.user.username}
                <a href={userUrl(data.civitaiUrl, review.user.username)} target="_blank" rel="noreferrer">
                  {review.user.username}
                </a>
              {:else}
                <span class="text-muted-foreground">User #{review.user.id}</span>
              {/if}
              <span class="text-xs text-muted-foreground">· {fmtDate(review.createdAt)}</span>
            </div>
          </div>

          <div class="grid grid-cols-3 gap-2">
            <div class="rounded-md border px-2 py-1">
              <div class="text-xs text-muted-foreground">System</div>
              <div class="text-sm font-semibold">{getBrowsingLevelLabel(review.currentLevel)}</div>
            </div>
            <div class="rounded-md border border-blue-500/40 bg-blue-500/10 px-2 py-1">
              <div class="text-xs text-muted-foreground">Owner suggested</div>
              <div class="text-sm font-semibold">{getBrowsingLevelLabel(review.suggestedLevel)}</div>
            </div>
            <div class="rounded-md border border-dashed px-2 py-1">
              <div class="text-xs text-muted-foreground">Mod applied</div>
              <div class="text-sm font-semibold">{getBrowsingLevelLabel(review.appliedLevel)}</div>
            </div>
          </div>

          {#if review.userComment}
            <div class="rounded-md bg-muted/40 p-2 text-sm">
              <span class="text-xs font-medium text-muted-foreground">Owner comment</span>
              <p class="whitespace-pre-wrap">{review.userComment}</p>
            </div>
          {:else}
            <span class="text-xs italic text-muted-foreground">No comment from owner</span>
          {/if}

          {#if review.status === 'Pending'}
            <form method="POST" action="?/resolve" use:enhance class="flex flex-col gap-2">
              <input type="hidden" name="reviewId" value={review.id} />
              <Textarea
                name="modComment"
                rows={2}
                placeholder="Optional moderator comment (visible to owner)"
                maxlength={1000}
              />
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-xs text-muted-foreground">Apply rating:</span>
                {#each browsingLevels as level (level)}
                  <Button
                    type="submit"
                    name="appliedLevel"
                    value={level}
                    size="sm"
                    variant={level === review.suggestedLevel ? 'default' : 'outline'}
                    title={level === review.suggestedLevel
                      ? 'Approve the owner’s suggestion'
                      : 'Override to this level'}
                  >
                    {getBrowsingLevelLabel(level)}
                  </Button>
                {/each}
              </div>
            </form>
          {:else}
            <div class="flex flex-col gap-1 text-sm">
              <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {#if review.resolver}
                  <span>Resolved by {review.resolver.username ?? `User #${review.resolver.id}`}</span>
                {:else}
                  <span class="italic">Auto-approved</span>
                {/if}
                {#if review.resolvedAt}<span>· {fmtDate(review.resolvedAt)}</span>{/if}
              </div>
              {#if review.modComment}
                <p class="whitespace-pre-wrap">{review.modComment}</p>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}

<div class="mt-4 flex flex-wrap items-center justify-between gap-2">
  <span class="text-sm text-muted-foreground">Page {data.page} of {totalPages}</span>
  <Pagination
    count={total}
    perPage={data.limit}
    page={data.page}
    onPageChange={(p) => p !== data.page && goto(urlWith({ page: p }))}
  >
    {#snippet children({ pages, currentPage })}
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious />
        </PaginationItem>
        {#each pages as p (p.key)}
          {#if p.type === 'ellipsis'}
            <PaginationItem>
              <PaginationEllipsis />
            </PaginationItem>
          {:else}
            <PaginationItem>
              <PaginationLink page={p} isActive={currentPage === p.value}>
                {p.value}
              </PaginationLink>
            </PaginationItem>
          {/if}
        {/each}
        <PaginationItem>
          <PaginationNext />
        </PaginationItem>
      </PaginationContent>
    {/snippet}
  </Pagination>
</div>
