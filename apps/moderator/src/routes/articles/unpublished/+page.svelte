<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { IconExternalLink } from '@tabler/icons-svelte';
  import { Tabs, TabsList, TabsTrigger } from '@civitai/ui/components/ui/tabs/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import {
    Pagination,
    PaginationContent,
    PaginationEllipsis,
    PaginationItem,
    PaginationLink,
    PaginationNext,
    PaginationPrevious,
  } from '@civitai/ui/components/ui/pagination/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import {
    articleStatusFilters,
    articleStatusBadge,
    humanizeUnpublishReason,
    articleUrl,
    userUrl,
  } from '$lib/articles';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const totalPages = $derived(Math.max(1, Math.ceil(data.totalItems / data.limit)));
  const fmtDate = (d: Date | null) => (d ? new Date(d).toLocaleDateString() : '—');

  function urlWith(params: Record<string, string | number | null>) {
    const url = new URL(page.url);
    for (const [k, v] of Object.entries(params)) {
      if (v === null) url.searchParams.delete(k);
      else url.searchParams.set(k, String(v));
    }
    return url.pathname + url.search;
  }

  function applyUsername(e: SubmitEvent) {
    e.preventDefault();
    const value = new FormData(e.currentTarget as HTMLFormElement).get('username');
    goto(urlWith({ username: String(value ?? '').trim() || null, page: 1 }));
  }

  // Delete is a permanent cascade (removes the article + its images from S3) — gate it behind a confirm.
  const confirmDelete = ({ cancel }: { cancel: () => void }) => {
    if (!confirm('Permanently delete this article and its images? This cannot be undone.')) cancel();
    return async ({ update }: { update: () => Promise<void> }) => update();
  };
</script>

<header class="page-header">
  <h1>Unpublished Articles</h1>
  <p>{data.totalItems} articles</p>
</header>

{#if form?.error}
  <div class="mb-4 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300">
    {form.error}
  </div>
{/if}

<div class="mb-4 flex flex-wrap items-end gap-x-6 gap-y-3">
  <div class="flex flex-col gap-1">
    <span class="text-xs font-medium text-muted-foreground">Status</span>
    <Tabs
      value={data.status}
      onValueChange={(v) => v && goto(urlWith({ status: v === 'all' ? null : v, page: 1 }))}
    >
      <TabsList>
        {#each articleStatusFilters as f (f.value)}
          <TabsTrigger value={f.value}>{f.label}</TabsTrigger>
        {/each}
      </TabsList>
    </Tabs>
  </div>

  <form class="flex items-end gap-1" onsubmit={applyUsername}>
    <div class="flex flex-col gap-1">
      <span class="text-xs font-medium text-muted-foreground">Username</span>
      <Input
        name="username"
        value={data.username}
        placeholder="Search by username…"
        class="h-8 w-52"
      />
    </div>
    <Button type="submit" size="sm" variant="outline">Search</Button>
  </form>
</div>

{#if data.items.length === 0}
  <div class="placeholder">No unpublished articles match this view.</div>
{:else}
  <div class="flex flex-col gap-3">
    {#each data.items as article (article.id)}
      <div class="flex gap-4 rounded-xl border p-3">
        {#if article.coverUrl}
          <div class="size-24 shrink-0 overflow-hidden rounded-lg bg-muted">
            <EdgeMedia
              src={article.coverUrl}
              type={article.coverType ?? undefined}
              width={96}
              alt={article.title}
              class="size-full object-cover"
            />
          </div>
        {/if}
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <div class="flex flex-wrap items-center gap-2">
            <a
              href={articleUrl(data.civitaiUrl, article.id)}
              target="_blank"
              rel="noreferrer"
              class="truncate font-semibold"
            >
              {article.title}
            </a>
            {#if articleStatusBadge[article.status]}
              <Badge class={articleStatusBadge[article.status].class}>
                {articleStatusBadge[article.status].label}
              </Badge>
            {/if}
            <a
              href={articleUrl(data.civitaiUrl, article.id)}
              target="_blank"
              rel="noreferrer"
              class="text-muted-foreground"
            >
              <IconExternalLink size={14} />
            </a>

            <div class="ml-auto flex shrink-0 items-center gap-2">
              <form method="POST" action="?/restore" use:enhance>
                <input type="hidden" name="id" value={article.id} />
                <Button type="submit" size="sm" variant="outline">Restore</Button>
              </form>
              <form method="POST" action="?/delete" use:enhance={confirmDelete}>
                <input type="hidden" name="id" value={article.id} />
                <Button type="submit" size="sm" variant="destructive">Delete</Button>
              </form>
            </div>
          </div>

          {#if article.username}
            <a
              href={userUrl(data.civitaiUrl, article.username)}
              target="_blank"
              rel="noreferrer"
              class="w-fit text-sm"
            >
              {article.username}
            </a>
          {/if}

          {#if article.status === 'UnpublishedViolation' && article.metadata?.unpublishedReason}
            <div class="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300">
              <span class="font-semibold">Reason:</span>
              {article.metadata.unpublishedReason === 'other'
                ? (article.metadata.customMessage ?? '—')
                : humanizeUnpublishReason(article.metadata.unpublishedReason)}
            </div>
          {/if}

          <div class="flex flex-wrap gap-4 text-xs text-muted-foreground">
            <span>Created {fmtDate(article.createdAt)}</span>
            {#if article.publishedAt}<span>Published {fmtDate(article.publishedAt)}</span>{/if}
            {#if article.metadata?.unpublishedAt}
              <span>Unpublished {fmtDate(new Date(article.metadata.unpublishedAt))}</span>
            {/if}
          </div>
        </div>
      </div>
    {/each}
  </div>
{/if}

<div class="mt-4 flex flex-wrap items-center justify-between gap-2">
  <span class="text-sm text-muted-foreground">Page {data.page} of {totalPages}</span>
  <Pagination
    count={data.totalItems}
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
