<script lang="ts">
  import { dateTime } from '$lib/format';
  import { enhance } from '$app/forms';
  import { goto, invalidateAll } from '$app/navigation';
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
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
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
  import type { ActionResult } from '@sveltejs/kit';
  import { FormState } from '$lib/form-state.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  /**
   * A `gone` refusal means the report was deleted underneath the moderator, so the queue reloads and
   * the row leaves — which closes the sheet through `selected`, taking the panel's own error with it.
   * A toast is the only surface that outlives that, and without one the row simply vanishes.
   * Every other refusal leaves the sheet open to fix and retry, which is `FormState`'s default.
   */
  const reloadIfGone = (result: ActionResult) => {
    if (result.type !== 'failure' || !result.data?.gone) return;
    toast.error(String(result.data.error ?? 'That report no longer exists.'));
    invalidateAll();
  };

  const statusForm = new FormState({ onSuccess: null, reload: true, onSettled: reloadIfGone });
  const notesForm = new FormState({ onSuccess: null, reload: true, onSettled: reloadIfGone });
  const placementForm = new FormState({ onSuccess: null, reload: true });
  const sweepForm = new FormState({ onSuccess: null, reload: true });

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

  // The sheet is open exactly when there is a report to show, rather than tracking openness on its
  // own. A status change invalidates and the row leaves the list — the queue defaults to the OPEN
  // statuses — so an independent `open` flag stayed true over a body that had rendered nothing, which
  // left the backdrop covering the page with no way back.
  const selected = $derived(
    selectedId != null ? (data.items.find((r) => r.id === selectedId) ?? null) : null
  );

  const totalPages = $derived(Math.max(1, Math.ceil(data.totalItems / data.limit)));
  const fmtDate = dateTime;

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
    // A refusal belongs to the report it was raised on; opening another must not inherit it.
    statusForm.error = null;
    notesForm.error = null;
    placementForm.error = null;
  }
</script>

<header class="page-header">
  <h1>{reportEntityLabels[data.type]} reports</h1>
  <p>{data.totalItems} reports</p>
</header>

<!-- Retool's `ActionAllPostReports`. Only meaningful here: the query keys on every image in the post
     already being blocked, which is a post-shaped question. -->
{#if data.type === 'post'}
  <form method="POST" action="?/actionResolvedPosts" use:enhance={sweepForm.enhance} class="mb-4">
    <Button type="submit" variant="outline" size="sm">Action reports already resolved by content</Button>
    <span class="ml-2 text-xs text-muted-foreground">
      Pending reports whose post is entirely blocked already.
    </span>
  </form>
  <!-- A bulk action that reports nothing is indistinguishable from one that did nothing. -->
  {#if form && 'actioned' in form && form.actioned != null}
    <p class="mb-4 text-sm text-green-300" role="status">
      Actioned {form.actioned} of {form.found}{form.skipped ? `, ${form.skipped} already handled` : ''}{form.more ? ' — more remain, run it again.' : ''}
    </p>
  {/if}
{/if}

{#if sweepForm.error}
  <p class="mb-4 text-sm text-red-300" role="alert">{sweepForm.error}</p>
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
        <!-- Identity first. The row named the reason and the reporter but never the thing reported, so
             "which model is this about" cost a Details click or a trip out to the site. -->
        <TableHead>{reportEntityLabels[data.type]}</TableHead>
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
        {@const itemUrl = getReportItemUrl(data.civitaiUrl, data.type, report.entityId, report.contextUrl)}
        <TableRow>
          <TableCell class="whitespace-nowrap tabular-nums">
            {#if report.entityId == null}
              <span class="text-muted-foreground">—</span>
            {:else if itemUrl}
              <a href={itemUrl} target="_blank" rel="noreferrer" class="link">#{report.entityId}</a>
            {:else}
              #{report.entityId}
            {/if}
          </TableCell>
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
                class="link"
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
          <TableCell colspan={8} class="py-8 text-center text-muted-foreground">
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

<Sheet open={!!selected} onOpenChange={(open) => !open && (selectedId = null)}>
  <SheetContent side="right" class="w-full overflow-y-auto sm:max-w-lg">
    {#if selected}
      {@const itemUrl = getReportItemUrl(data.civitaiUrl, data.type, selected.entityId, selected.contextUrl)}
      {@const placementId = reportedPlacementId(selected.details, selected.reason)}
      <SheetHeader>
        <SheetTitle>{reportEntityLabels[data.type]} report #{selected.id}</SheetTitle>
      </SheetHeader>

      <div class="flex flex-col gap-5 px-4 pb-6">
        {#if itemUrl}
          <a href={itemUrl} target="_blank" rel="noreferrer" class="link inline-flex items-center gap-1">
            View {reportEntityLabels[data.type].toLowerCase()}{#if selected.entityId != null}
              #{selected.entityId}{/if}
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
              <form method="POST" action="?/removePlacement" use:enhance={placementForm.enhance} class="flex flex-wrap gap-2">
                <input type="hidden" name="placementId" value={placementId} />
                <Button type="submit" size="sm" variant="destructive" disabled={placementForm.submitting}>
                  Yes, remove it
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onclick={() => (confirmingPlacement = null)}
                >
                  Cancel
                </Button>
              </form>
            {/if}
            {#if placementForm.error}
              <p class="mt-2 text-sm text-red-300" role="alert">{placementForm.error}</p>
            {/if}
            {#if confirmingPlacement !== placementId}
              <Button size="sm" variant="destructive" onclick={() => (confirmingPlacement = placementId)}>
                Remove placement
              </Button>
            {/if}
          </div>
        {/if}

        <form method="POST" action="?/setStatus" use:enhance={statusForm.enhance} class="flex flex-col gap-2">
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
          {#if statusForm.error}
            <p class="text-sm text-red-300" role="alert">{statusForm.error}</p>
          {/if}
        </form>

        <form method="POST" action="?/saveNotes" use:enhance={notesForm.enhance} class="flex flex-col gap-2">
          <input type="hidden" name="id" value={selected.id} />
          <span class="text-sm font-medium">Internal notes</span>
          <Textarea name="internalNotes" rows={3} value={selected.internalNotes ?? ''} />
          <Button type="submit" size="sm" class="self-end" disabled={notesForm.submitting}>
            Save notes
          </Button>
          {#if notesForm.error}
            <p class="text-sm text-red-300" role="alert">{notesForm.error}</p>
          {/if}
        </form>
      </div>
    {:else}
      <!-- Reached while the sheet plays its exit animation with `selected` already null, which happens
           two ways: an action emptied the row (bits-ui does not fire `onOpenChange` for a
           parent-driven close, so `selectedId` still holds it) or the moderator clicked the X (which
           does, so it is null). Only the first is an update, and only a `success` outcome is one at
           all — `gone` means the report was deleted and the edit dropped. Both conditions, or this
           says "Report updated." at someone who read a report and closed it. -->
      {#if selectedId !== null && form && 'success' in form && form.success}
        <div class="p-6 text-sm text-muted-foreground">Report updated.</div>
      {/if}
    {/if}
  </SheetContent>
</Sheet>
