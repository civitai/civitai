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
    reportDetail,
    gameFrameReportImage,
  } from '$lib/reports';
  import { serviceOfferingTakedownReasons } from '@civitai/shared/service-offering-takedown';
  import { browsingLevelLabels } from '@civitai/shared';
  import type { ActionResult } from '@sveltejs/kit';
  import { FormState } from '$lib/form-state.svelte';
  import type { PageData } from './$types';
  import LastWorked from '$lib/components/report-queue/LastWorked.svelte';

  let { data }: { data: PageData } = $props();

  /**
   * A `gone` refusal means the report was deleted underneath the moderator, so the queue reloads and
   * the row leaves — and the panel moves on to the row that took its place (see `selected`). A toast
   * is the only surface that outlives that, so the panel's own copy of the refusal is cleared rather
   * than left showing against a report it was not about.
   * Every other refusal leaves the panel on the report to fix and retry, which is `FormState`'s default.
   */
  const reloadIfGone = (result: ActionResult) => {
    if (result.type !== 'failure' || !result.data?.gone) return;
    toast.error(String(result.data.error ?? 'That report no longer exists.'));
    clearPanelState();
    invalidateAll();
  };

  // A status change usually takes the row out of the view and the panel straight on to the next one,
  // so nothing left on screen says the write landed. Captured at submit because the reload replaces
  // `selected` before `onSuccess` runs.
  let statusChange: { id: number; status: string } | null = null;
  const statusForm = new FormState({
    onSubmit: ({ formData }) =>
      (statusChange = { id: Number(formData.get('id')), status: String(formData.get('status')) }),
    onSuccess: () => {
      if (statusChange) toast.success(`Report #${statusChange.id} set to ${statusChange.status}`);
    },
    reload: true,
    onSettled: reloadIfGone,
  });
  const notesForm = new FormState({ onSuccess: null, reload: true, onSettled: reloadIfGone });
  const delistForm = new FormState({
    onSuccess: (result) => {
      confirmingDelist = null;
      toast.success(String(result?.delisted ?? 'Delisted'));
    },
    reload: true,
    onSettled: reloadIfGone,
  });

  let selectedId = $state<number | null>(null);
  // Where the chosen row sat when it was chosen. Not derived from `selectedId`: it is needed exactly
  // when that row is no longer in the list to look up.
  let selectedIndex = $state(0);
  let confirmingDelist = $state<number | null>(null);
  const storylineForm = new FormState({
    onSuccess: (result) => {
      confirmingTakedown = null;
      toast.success(String(result?.storylineTakedown ?? 'Done'));
    },
    reload: true,
    onSettled: reloadIfGone,
  });
  let confirmingTakedown = $state<number | null>(null);
  const offeringForm = new FormState({
    onSuccess: (result) => {
      confirmingOfferingTakedown = null;
      toast.success(String(result?.serviceOfferingTakedown ?? 'Done'));
    },
    reload: true,
    onSettled: reloadIfGone,
  });
  let confirmingOfferingTakedown = $state<number | null>(null);
  let offeringReason = $state<string>('');
  // The reporter's own words, wherever this entity type puts them: `comment` is the free-text field on
  // most forms, `violation`/`reason` is what the picker-driven ones carry.
  const reportComment = (r: { details: unknown }) =>
    reportDetail(r.details, 'comment') ??
    reportDetail(r.details, 'violation') ??
    reportDetail(r.details, 'reason');

  // Derived from the loaded rows rather than held as its own copy, and never empty while there are
  // rows: the panel's space is reserved, so it always shows a report — the first one until a row is
  // picked. A status change invalidates and the row leaves the list (the queue defaults to the OPEN
  // statuses); falling back to the same POSITION then lands on the row that slid up into its place,
  // so actioning a report moves straight on to the next without another click.
  const selected = $derived(
    data.items.find((r) => r.id === selectedId) ??
      data.items[Math.min(selectedIndex, data.items.length - 1)] ??
      null
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

  // Every filter or page change goes through here, so the panel starts again at the new view's first
  // report rather than at whatever position the last view had reached.
  function navigate(href: string) {
    selectedId = null;
    selectedIndex = 0;
    clearPanelState();
    goto(href);
  }

  function applyMulti(key: string, values: string[]) {
    const url = new URL(page.url);
    url.searchParams.delete(key);
    // Keep an empty param on clear so it reads as "all", not a reset to defaults.
    if (values.length === 0) url.searchParams.set(key, '');
    else values.forEach((v) => url.searchParams.append(key, v));
    url.searchParams.set('page', '1');
    navigate(url.pathname + url.search);
  }

  const statusOptions = reportStatuses.map((s) => ({ value: s, label: s }));
  const reasonOptions = reportReasons.map((r) => ({ value: r, label: reportReasonLabels[r] }));

  function applyReportedBy(e: SubmitEvent) {
    e.preventDefault();
    const value = new FormData(e.currentTarget as HTMLFormElement).get('reportedBy');
    navigate(urlWith({ reportedBy: String(value ?? '').trim() || null, page: 1 }));
  }

  function openDetails(id: number) {
    selectedId = id;
    selectedIndex = Math.max(0, data.items.findIndex((r) => r.id === id));
    clearPanelState();
  }

  // A refusal belongs to the report it was raised on; showing another must not inherit it.
  function clearPanelState() {
    statusForm.error = null;
    notesForm.error = null;
    delistForm.error = null;
    confirmingDelist = null;
    storylineForm.error = null;
    confirmingTakedown = null;
    offeringForm.error = null;
    confirmingOfferingTakedown = null;
    offeringReason = '';
  }

  // The row is the target, but it also holds links (the item, the reporter) that must keep doing
  // their own thing — and a drag to copy a username out of a row is not a request to open it.
  function onRowClick(e: MouseEvent, id: number) {
    if ((e.target as HTMLElement).closest('a, button')) return;
    if (window.getSelection()?.toString()) return;
    openDetails(id);
  }

  function onRowKeydown(e: KeyboardEvent, id: number) {
    if (e.target !== e.currentTarget) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    openDetails(id);
  }
</script>

<header class="page-header">
  <h1>{reportEntityLabels[data.type]} reports</h1>
  <p>{data.totalItems} reports</p>
  <LastWorked entity={data.type} />
</header>


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

<!-- The details sit beside the table, never over it: a drawer covered the queue, so working down it was
     open, read, close, open the next. Here the next row stays one click away while one is open. -->
<div class="flex flex-col gap-4 xl:flex-row xl:items-start">
  <div class="min-w-0 flex-1">
    <div class="rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <!-- Identity first. The row named the reason and the reporter but never the thing reported, so
                 "which model is this about" cost a Details click or a trip out to the site. -->
            <TableHead>{reportEntityLabels[data.type]}</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Reported</TableHead>
            <TableHead>Reported by</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each data.items as report (report.id)}
            {@const itemUrl = getReportItemUrl(data.civitaiUrl, data.type, report.entityId, report.contextUrl)}
            <!-- Striped, and the open row marked with the same blue as the report queues. The stripe is
                 dropped on the open row rather than layered under it, so which one wins never depends
                 on Tailwind's variant order. -->
            <TableRow
              tabindex={0}
              aria-selected={report.id === selected?.id}
              data-state={report.id === selected?.id ? 'selected' : undefined}
              class="cursor-pointer {report.id === selected?.id
                ? 'bg-blue-500/15 shadow-[inset_3px_0_0_var(--color-blue-500)] hover:bg-blue-500/20'
                : 'odd:bg-dark-7/40'}"
              onclick={(e) => onRowClick(e, report.id)}
              onkeydown={(e) => onRowKeydown(e, report.id)}
            >
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
                <!-- Everyone else who filed the same report, folded into the filer's cell rather than
                     a column of its own that sat empty on most rows. -->
                {#if report.alsoReportedByCount}
                  <span
                    class="ml-1 text-xs tabular-nums text-muted-foreground"
                    title={`Also reported by ${report.alsoReportedByCount} other ${report.alsoReportedByCount === 1 ? 'user' : 'users'}`}
                  >
                    +{report.alsoReportedByCount}
                  </span>
                {/if}
              </TableCell>
            </TableRow>
          {:else}
            <TableRow>
              <TableCell colspan={5} class="py-8 text-center text-muted-foreground">
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
        onPageChange={(p) => p !== data.page && navigate(urlWith({ page: p }))}
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
  </div>

  <!-- Always present, so the table keeps one width instead of reflowing every time a row is opened.
       Sticky with its own scroll, so a moderator halfway down fifty rows still sees the panel, and the
       status buttons at its foot are reachable without scrolling the table away. -->
  <aside
    aria-label="Report details"
    class="rounded-xl border xl:sticky xl:top-4 xl:max-h-[calc(100svh-2rem)] xl:w-md xl:shrink-0 xl:overflow-y-auto"
  >
    <h2 class="m-0 px-4 pt-4 pb-3 text-base font-semibold">
      {#if selected}{reportEntityLabels[data.type]} report #{selected.id}{:else}Report details{/if}
    </h2>
    {#if selected}
      {@const itemUrl = getReportItemUrl(data.civitaiUrl, data.type, selected.entityId, selected.contextUrl)}
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
          <dd>{selected.reportedByUsername ?? '—'}{selected.reason === 'Ownership' && selected.reportedByEmail ? ` (${selected.reportedByEmail})` : ''}{selected.alsoReportedByCount ? `, and ${selected.alsoReportedByCount} more` : ''}</dd>
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


        {#if data.type === 'gameFrameGame'}
          {@const game = data.games.find((g) => g.id === selected.entityId)}
          {@const reportedImage = gameFrameReportImage(selected.details)}
          {#if reportedImage}
            <div class="rounded-lg border p-3">
              <p class="mb-2 text-sm">
                This report is about one player's picture in a room of this game, not the game itself.
                Civitai Games keeps the picture for 7 days after the report.
              </p>
              <a href={reportedImage} target="_blank" rel="noreferrer">
                <img
                  src={reportedImage}
                  alt="Reported player upload"
                  referrerpolicy="no-referrer"
                  class="max-h-80 w-full rounded border bg-muted/40 object-contain"
                />
              </a>
            </div>
          {/if}
          <div class="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
            {#if game}
              <p class="mb-2 flex flex-wrap items-center gap-2 text-sm">
                <span class="font-medium">{game.title}</span>
                <Badge variant="outline">{game.visibility}</Badge>
                {#if game.official}<Badge variant="outline">official</Badge>{/if}
              </p>
              {#if game.visibility === 'delisted'}
                <p class="mb-2 text-sm">Already delisted on Civitai Games.</p>
              {/if}
            {:else}
              <p class="mb-2 text-sm text-muted-foreground">Game details unavailable.</p>
            {/if}
            <p class="mb-2 text-sm">
              Delisting takes this game and its forks off Civitai Games, then sets this report Actioned.
              Undelisting is done on Civitai Games.
            </p>
            {#if confirmingDelist === selected.id}
              <form method="POST" action="?/delistGame" use:enhance={delistForm.enhance} class="flex flex-wrap gap-2">
                <input type="hidden" name="id" value={selected.id} />
                <Button type="submit" size="sm" variant="destructive" disabled={delistForm.submitting}>
                  Yes, delist it
                </Button>
                <Button type="button" size="sm" variant="outline" onclick={() => (confirmingDelist = null)}>
                  Cancel
                </Button>
              </form>
            {:else}
              <Button size="sm" variant="destructive" onclick={() => (confirmingDelist = selected.id)}>
                {game?.visibility === 'delisted' ? 'Confirm delisted and action' : 'Delist game'}
              </Button>
            {/if}
            {#if delistForm.error}
              <p class="mt-2 text-sm text-red-300" role="alert">{delistForm.error}</p>
            {/if}
          </div>
        {/if}

        {#if data.type === 'storyline'}
          {@const storyline = data.storylines.find((st) => st.id === selected.entityId)}
          <div class="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
            {#if storyline}
              <p class="mb-2 flex flex-wrap items-center gap-2 text-sm">
                <span class="font-medium">{storyline.title}</span>
                {#if storyline.tosViolationByModerator}
                  <Badge variant="outline">taken down by a moderator</Badge>
                {/if}
                {#if storyline.tosViolationByScan}
                  <Badge variant="outline">taken down by title scan</Badge>
                {/if}
              </p>
            {:else}
              <p class="mb-2 text-sm text-muted-foreground">This storyline no longer exists.</p>
            {/if}
            {#if storyline && !storyline.tosViolationByModerator}
              <p class="mb-2 text-sm">
                Taking it down hides the storyline from everyone but its owner and moderators, then sets this report
                Actioned. A later clean scan of its title does not bring it back.
                {#if storyline.tosViolationByScan}
                  Its title scan already keeps it down; this holds it down after the scan lifts.
                {/if}
              </p>
              {#if confirmingTakedown === selected.id}
                <form method="POST" action="?/takeDownStoryline" use:enhance={storylineForm.enhance} class="flex flex-wrap gap-2">
                  <input type="hidden" name="id" value={selected.id} />
                  <Button type="submit" size="sm" variant="destructive" disabled={storylineForm.submitting}>
                    Yes, take it down
                  </Button>
                  <Button type="button" size="sm" variant="outline" onclick={() => (confirmingTakedown = null)}>
                    Cancel
                  </Button>
                </form>
              {:else}
                <Button size="sm" variant="destructive" onclick={() => (confirmingTakedown = selected.id)}>
                  Take down storyline
                </Button>
              {/if}
            {:else if storyline}
              {#if storyline.tosViolationByScan}
                <p class="mb-2 text-sm">
                  Restoring lifts the moderator takedown only. Its title scan still keeps it down.
                </p>
              {/if}
              <form method="POST" action="?/restoreStoryline" use:enhance={storylineForm.enhance}>
                <input type="hidden" name="id" value={selected.id} />
                <Button type="submit" size="sm" variant="outline" disabled={storylineForm.submitting}>
                  Restore storyline
                </Button>
              </form>
            {/if}
            {#if storyline?.tosViolationByScan}
              <p class="mt-3 mb-2 text-sm">
                Lifting ends the takedown its title scan made for the title above, and a scan of the same title does
                not take it down again. Read the title first.
              </p>
              <form method="POST" action="?/liftStorylineScanTakedown" use:enhance={storylineForm.enhance}>
                <input type="hidden" name="id" value={selected.id} />
                <input type="hidden" name="reviewedTitle" value={storyline.title} />
                <Button type="submit" size="sm" variant="outline" disabled={storylineForm.submitting}>
                  Lift takedown
                </Button>
              </form>
            {/if}
            {#if storylineForm.error}
              <p class="mt-2 text-sm text-red-300" role="alert">{storylineForm.error}</p>
            {/if}
          </div>
        {/if}

        {#if data.type === 'serviceOffering'}
          {@const offering = data.serviceOfferings.find((o) => o.id === selected.entityId)}
          <div class="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
            {#if offering}
              <p class="mb-1 flex flex-wrap items-center gap-2 text-sm">
                <span class="font-medium">{offering.title}</span>
                <Badge variant="outline">{offering.status}</Badge>
                <Badge variant="outline">
                  {(browsingLevelLabels as Record<number, string | undefined>)[offering.maxNsfwLevel] ??
                    `rating ${offering.maxNsfwLevel}`}
                </Badge>
                {#if offering.removedReason}
                  <Badge variant="outline">taken down by a moderator</Badge>
                {/if}
              </p>
              <p class="mb-1 text-sm text-dark-2">
                by {offering.sellerUsername ?? `user #${offering.sellerId}`}
              </p>
              <p class="mb-2 whitespace-pre-wrap text-sm">{offering.description}</p>
              {#if offering.removedReason}
                <p class="mb-2 text-sm">
                  Reason: {serviceOfferingTakedownReasons[
                    offering.removedReason as keyof typeof serviceOfferingTakedownReasons
                  ]?.optionLabel ?? offering.removedReason}{offering.removedDetails
                    ? `: ${offering.removedDetails}`
                    : ''}
                </p>
              {/if}
            {:else}
              <p class="mb-2 text-sm text-muted-foreground">This service no longer exists.</p>
            {/if}
            {#if offering && !offering.removedReason}
              <p class="mb-2 text-sm">
                Taking it down removes the service from its seller's shop for good and tells the seller why, then
                sets this report Actioned. Its open deals carry on; a request not yet accepted can only be declined.
              </p>
              {#if confirmingOfferingTakedown === selected.id}
                <form
                  method="POST"
                  action="?/takeDownServiceOffering"
                  use:enhance={offeringForm.enhance}
                  class="flex flex-col gap-2"
                >
                  <input type="hidden" name="id" value={selected.id} />
                  <select
                    name="reason"
                    class="h-8 rounded-md border bg-background px-2 text-sm"
                    bind:value={offeringReason}
                    required
                  >
                    <option value="" disabled>Reason</option>
                    {#each Object.entries(serviceOfferingTakedownReasons) as [key, reason] (key)}
                      <option value={key}>{reason.optionLabel}</option>
                    {/each}
                  </select>
                  <Textarea
                    name="details"
                    maxlength={1000}
                    required={offeringReason === 'other'}
                    placeholder={offeringReason === 'other'
                      ? 'What is wrong (sent to the seller)'
                      : 'Note for moderators (optional, not sent to the seller)'}
                  />
                  <!-- Shown as text too: a typed note hides the placeholder, and Other sends it. -->
                  <p class="text-xs text-dark-2">
                    {offeringReason === 'other'
                      ? 'This text is sent to the seller as the reason.'
                      : 'Kept with the takedown for moderators; the seller sees only the reason.'}
                  </p>
                  <div class="flex flex-wrap gap-2">
                    <Button type="submit" size="sm" variant="destructive" disabled={offeringForm.submitting}>
                      Yes, take it down
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onclick={() => {
                        confirmingOfferingTakedown = null;
                        offeringReason = '';
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              {:else}
                <Button
                  size="sm"
                  variant="destructive"
                  onclick={() => {
                    // A reason is picked per report, never carried over from the last one.
                    offeringReason = '';
                    confirmingOfferingTakedown = selected.id;
                  }}
                >
                  Take down service
                </Button>
              {/if}
            {/if}
            {#if offeringForm.error}
              <p class="mt-2 text-sm text-red-300" role="alert">{offeringForm.error}</p>
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
      <!-- Only when the view itself is empty: `selected` falls back to a row whenever there is one. -->
      <p class="px-4 pb-6 text-sm text-muted-foreground">No reports in this view.</p>
    {/if}
  </aside>
</div>
