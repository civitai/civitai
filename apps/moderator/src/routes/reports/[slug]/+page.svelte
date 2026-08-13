<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { IconExternalLink } from '@tabler/icons-svelte';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
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
  import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
  } from '@civitai/ui/components/ui/sheet/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { MultiCombobox } from '@civitai/ui/components/ui/multi-combobox/index.js';
  import {
    reportEntityLabels,
    reportStatuses,
    reportReasons,
    reportReasonLabels,
    reportStatusBadgeClass,
    getReportItemUrl,
    reportedPlacementId,
    reportDetail,
  } from '$lib/reports';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let selectedId = $state<number | null>(null);
  // Armed per placement id, so closing the sheet and opening another report cannot leave a live
  // destructive button pointed at the previous one.
  let confirmingPlacement = $state<number | null>(null);
  // The reporter's own words, wherever this entity type puts them: `comment` is the free-text field on
  // most forms, `violation`/`reason` is what the picker-driven ones carry.
  const reportComment = (r: { details: unknown }) =>
    reportDetail(r.details, 'comment') ??
    reportDetail(r.details, 'violation') ??
    reportDetail(r.details, 'reason');

  let detailsOpen = $state(false);
  const selected = $derived(
    selectedId != null ? (data.items.find((r) => r.id === selectedId) ?? null) : null
  );

  const totalPages = $derived(Math.max(1, Math.ceil(data.totalItems / data.limit)));
  const fmtDate = (d: Date) => new Date(d).toLocaleString();

  function urlWith(params: Record<string, string | number | null>) {
    const url = new URL(page.url);
    for (const [k, v] of Object.entries(params)) {
      if (v === null) url.searchParams.delete(k);
      else url.searchParams.set(k, String(v));
    }
    return url.pathname + url.search;
  }

  function applyMulti(key: string, values: string[]) {
    const url = new URL(page.url);
    url.searchParams.delete(key);
    // Keep an empty param on clear so it reads as "all", not a reset to defaults.
    if (values.length === 0) url.searchParams.set(key, '');
    else values.forEach((v) => url.searchParams.append(key, v));
    url.searchParams.set('page', '1');
    goto(url.pathname + url.search);
  }

  const statusOptions = reportStatuses.map((s) => ({ value: s, label: s }));
  const reasonOptions = reportReasons.map((r) => ({ value: r, label: reportReasonLabels[r] }));

  function applyReportedBy(e: SubmitEvent) {
    e.preventDefault();
    const value = new FormData(e.currentTarget as HTMLFormElement).get('reportedBy');
    goto(urlWith({ reportedBy: String(value ?? '').trim() || null, page: 1 }));
  }

  function openDetails(id: number) {
    selectedId = id;
    detailsOpen = true;
  }
</script>

<header class="page-header">
  <h1>{reportEntityLabels[data.type]} reports</h1>
  <p>{data.totalItems} reports</p>
</header>

<!-- Retool's `ActionAllPostReports`. Only meaningful here: the query keys on every image in the post
     already being blocked, which is a post-shaped question. -->
{#if data.type === 'post'}
  <form method="POST" action="?/actionResolvedPosts" use:enhance class="mb-4">
    <Button type="submit" variant="outline" size="sm">Action reports already resolved by content</Button>
    <span class="ml-2 text-xs text-muted-foreground">
      Pending reports whose post is entirely blocked already.
    </span>
  </form>
  <!-- A bulk action that reports nothing is indistinguishable from one that did nothing. -->
  {#if form && 'message' in form && form.message}
    <p class="mb-4 text-sm text-amber-300" role="status">{form.message}</p>
  {:else if form && 'actioned' in form && form.actioned != null}
    <p class="mb-4 text-sm text-green-300" role="status">
      Actioned {form.actioned} of {form.found}{form.skipped ? `, ${form.skipped} already handled` : ''}{form.more ? ' — more remain, run it again.' : ''}
    </p>
  {/if}
{/if}

<div class="mb-4 flex flex-wrap items-end gap-x-6 gap-y-3">
  <div class="flex flex-col gap-1">
    <span class="text-xs font-medium text-muted-foreground">Status</span>
    <MultiCombobox
      options={statusOptions}
      value={data.statuses}
      onValueChange={(vals) => applyMulti('status', vals)}
      placeholder="Search statuses…"
    />
  </div>

  <div class="flex flex-col gap-1">
    <span class="text-xs font-medium text-muted-foreground">Reason</span>
    <MultiCombobox
      options={reasonOptions}
      value={data.reasons}
      onValueChange={(vals) => applyMulti('reason', vals)}
      placeholder="Search reasons…"
    />
  </div>

  <form class="flex items-end gap-1" onsubmit={applyReportedBy}>
    <div class="flex flex-col gap-1">
      <span class="text-xs font-medium text-muted-foreground">Reported by</span>
      <Input name="reportedBy" value={data.reportedBy} placeholder="username" class="h-8 w-40" />
    </div>
    <Button type="submit" size="sm" variant="outline">Search</Button>
  </form>
</div>

{#if data.hidingAutomated}
  <p class="mb-4 text-xs text-muted-foreground">
    Automated reports are hidden — this queue and its badge both count only reports people filed.
    <button type="button" class="underline" onclick={() => applyMulti('reason', [])}>
      Show automated reports
    </button>
  </p>
{/if}

<div class="rounded-xl border">
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Reason</TableHead>
        <TableHead>Details</TableHead>
        <TableHead>Status</TableHead>
        <TableHead>Reported</TableHead>
        <TableHead>Reported by</TableHead>
        <TableHead class="text-right">Also</TableHead>
        <TableHead class="w-px"></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each data.items as report (report.id)}
        {@const itemUrl = getReportItemUrl(data.civitaiUrl, data.type, report.entityId)}
        <TableRow>
          <TableCell>{report.reason}</TableCell>
          <!-- Retool's Details column. The reporter's own words decide whether a row is worth opening,
               and reading them meant opening the sheet and picking them out of a JSON dump. -->
          <TableCell class="max-w-sm">
            <span class="line-clamp-2 text-sm text-muted-foreground" title={reportComment(report)}>
              {reportComment(report) ?? '—'}
            </span>
          </TableCell>
          <TableCell>
            <Badge class={reportStatusBadgeClass[report.status]}>{report.status}</Badge>
          </TableCell>
          <TableCell class="whitespace-nowrap text-sm text-muted-foreground">
            {fmtDate(report.createdAt)}
          </TableCell>
          <TableCell>
            {#if report.reportedByUsername}
              <a
                href={`${data.civitaiUrl}/user/${report.reportedByUsername}`}
                target="_blank"
                rel="noreferrer"
              >
                {report.reportedByUsername}
              </a>
            {:else}
              <span class="text-muted-foreground">—</span>
            {/if}
          </TableCell>
          <TableCell class="text-right tabular-nums">
            {report.alsoReportedByCount || ''}
          </TableCell>
          <TableCell class="flex items-center gap-1">
            <Button size="sm" variant="secondary" onclick={() => openDetails(report.id)}>
              Details
            </Button>
            {#if itemUrl}
              <Button href={itemUrl} target="_blank" rel="noreferrer" size="icon" variant="ghost">
                <IconExternalLink size={16} />
              </Button>
            {/if}
          </TableCell>
        </TableRow>
      {:else}
        <TableRow>
          <TableCell colspan={7} class="py-8 text-center text-muted-foreground">
            No reports match this view.
          </TableCell>
        </TableRow>
      {/each}
    </TableBody>
  </Table>
</div>

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

<Sheet bind:open={detailsOpen}>
  <SheetContent side="right" class="w-full overflow-y-auto sm:max-w-lg">
    {#if selected}
      {@const itemUrl = getReportItemUrl(data.civitaiUrl, data.type, selected.entityId)}
      {@const placementId = reportedPlacementId(selected.details, selected.reason)}
      <SheetHeader>
        <SheetTitle>{reportEntityLabels[data.type]} report #{selected.id}</SheetTitle>
      </SheetHeader>

      <div class="flex flex-col gap-5 px-4 pb-6">
        {#if itemUrl}
          <a href={itemUrl} target="_blank" rel="noreferrer" class="inline-flex items-center gap-1">
            View {reportEntityLabels[data.type].toLowerCase()}
            <IconExternalLink size={14} />
          </a>
        {/if}

        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt class="text-muted-foreground">Reason</dt>
          <dd>{selected.reason}</dd>
          <dt class="text-muted-foreground">Reported by</dt>
          <dd>{selected.reportedByUsername ?? '—'}{selected.reason === 'Ownership' && selected.reportedByEmail ? ` (${selected.reportedByEmail})` : ''}</dd>
          <dt class="text-muted-foreground">Reported</dt>
          <dd>{fmtDate(selected.createdAt)}</dd>
        </dl>

        {#if reportComment(selected)}
          <p class="wrap-break-word text-sm">{reportComment(selected)}</p>
        {/if}

        {#if selected.details}
          <pre class="max-h-64 overflow-auto rounded-lg border bg-muted/40 p-3 text-xs">{JSON.stringify(
              selected.details,
              null,
              2
            )}</pre>
        {/if}

        <!-- A sticker report has always carried which placement it is about; until main added this
             (#3766) nothing consumed it, so a moderator read the id out of the details dump above and
             had no way to act on it. Removal is not reversible and settles escrow, so it confirms. -->
        {#if placementId !== null}
          <div class="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
            <p class="mb-2 text-sm">
              This report is about sticker placement <code>#{placementId}</code>. Removing it takes the
              sticker off the image for everyone.
            </p>
            {#if confirmingPlacement === placementId}
              <form method="POST" action="?/removePlacement" use:enhance class="flex flex-wrap gap-2">
                <input type="hidden" name="placementId" value={placementId} />
                <Button type="submit" size="sm" variant="destructive">Yes, remove it</Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onclick={() => (confirmingPlacement = null)}
                >
                  Cancel
                </Button>
              </form>
            {:else}
              <Button size="sm" variant="destructive" onclick={() => (confirmingPlacement = placementId)}>
                Remove placement
              </Button>
            {/if}
          </div>
        {/if}

        <form method="POST" action="?/setStatus" use:enhance class="flex flex-col gap-2">
          <input type="hidden" name="id" value={selected.id} />
          <span class="text-sm font-medium">Status</span>
          <div class="flex flex-wrap gap-2">
            {#each reportStatuses as status (status)}
              <Button
                type="submit"
                name="status"
                value={status}
                size="sm"
                variant={status === selected.status ? 'default' : 'outline'}
                disabled={status === selected.status}
              >
                {status}
              </Button>
            {/each}
          </div>
        </form>

        <form method="POST" action="?/saveNotes" use:enhance class="flex flex-col gap-2">
          <input type="hidden" name="id" value={selected.id} />
          <span class="text-sm font-medium">Internal notes</span>
          <Textarea name="internalNotes" rows={3} value={selected.internalNotes ?? ''} />
          <Button type="submit" size="sm" class="self-end">Save notes</Button>
        </form>
      </div>
    {:else}
      <div class="p-6 text-sm text-muted-foreground">Report updated.</div>
    {/if}
  </SheetContent>
</Sheet>
