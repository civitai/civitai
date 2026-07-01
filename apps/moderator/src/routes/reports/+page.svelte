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
  import { Tabs, TabsList, TabsTrigger } from '@civitai/ui/components/ui/tabs/index.js';
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
    reportEntities,
    reportEntityLabels,
    reportStatuses,
    reportReasons,
    reportReasonLabels,
    reportStatusBadgeClass,
    getReportItemUrl,
  } from '$lib/reports';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let selectedId = $state<number | null>(null);
  let detailsOpen = $state(false);
  const selected = $derived(
    selectedId != null ? (data.items.find((r) => r.id === selectedId) ?? null) : null
  );

  const totalPages = $derived(Math.max(1, Math.ceil(data.totalItems / data.limit)));
  const fmtDate = (d: Date) => new Date(d).toLocaleString();

  // Build a URL off the current one, overriding the given params (null deletes).
  function urlWith(params: Record<string, string | number | null>) {
    const url = new URL(page.url);
    for (const [k, v] of Object.entries(params)) {
      if (v === null) url.searchParams.delete(k);
      else url.searchParams.set(k, String(v));
    }
    return url.pathname + url.search;
  }

  // Replace a multi-valued filter (status/reason) with the given set and navigate, resetting to page 1.
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
  <h1>Reports</h1>
  <p>{data.totalItems} reports</p>
</header>

<Tabs
  value={data.type}
  onValueChange={(v) => v && goto(urlWith({ type: v, page: 1 }))}
  class="mb-4"
>
  <TabsList class="h-auto flex-wrap justify-start">
    {#each reportEntities as entity (entity)}
      <TabsTrigger value={entity}>{reportEntityLabels[entity]}</TabsTrigger>
    {/each}
  </TabsList>
</Tabs>

<div class="mb-4 flex flex-wrap items-end gap-x-6 gap-y-3">
  <div class="flex flex-col gap-1">
    <span class="text-xs font-medium text-muted-foreground">Status</span>
    <MultiCombobox
      options={statusOptions}
      value={data.statuses}
      onValueChange={(vals) => applyMulti('status', vals)}
      placeholder="Search statuses…"
      // class="w-64"
    />
  </div>

  <div class="flex flex-col gap-1">
    <span class="text-xs font-medium text-muted-foreground">Reason</span>
    <MultiCombobox
      options={reasonOptions}
      value={data.reasons}
      onValueChange={(vals) => applyMulti('reason', vals)}
      placeholder="Search reasons…"
      // class="w-64"
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

<div class="rounded-xl border">
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Reason</TableHead>
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
          <TableCell colspan={6} class="py-8 text-center text-muted-foreground">
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

        {#if selected.details}
          <pre class="max-h-64 overflow-auto rounded-lg border bg-muted/40 p-3 text-xs">{JSON.stringify(
              selected.details,
              null,
              2
            )}</pre>
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
