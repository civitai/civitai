<script lang="ts">
  import { dateTime } from '$lib/format';
  import { enhance } from '$app/forms';
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { IconExternalLink } from '@tabler/icons-svelte';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import {
    MODEL_UNPUBLISH_REASONS,
    MINOR_UNPUBLISH_REASONS,
    type ModelUnpublishReason,
  } from '$lib/model-unpublish-reasons';
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
  } from '$lib/reports';
  import type { ActionResult } from '@sveltejs/kit';
  import { FormState } from '$lib/form-state.svelte';
  import OwnerFlaggedMinorBadge from '$lib/components/minor-flags/OwnerFlaggedMinorBadge.svelte';
  import ModelPreview from './ModelPreview.svelte';
  import type { PageData } from './$types';

  // No `form`: every write here goes through a per-form `FormState`, which carries its own result.
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
  // A model action takes the report out of the queue and the panel on to the next one, so its own
  // state is cleared on success — a reason picked for one model must not be pre-filled on the next.
  const moderateForm = new FormState({
    onSuccess: (result) => {
      unpublishReason = '';
      confirmingModel = null;
      toast.success(String(result?.moderated ?? 'Done'));
    },
    reload: true,
    onSettled: reloadIfGone,
  });
  let unpublishReason = $state<ModelUnpublishReason | ''>('');
  // `<action>:<report id>`, so an armed Take down cannot survive moving to another report.
  let confirmingModel = $state<string | null>(null);

  let selectedId = $state<number | null>(null);
  // Where the chosen row sat when it was chosen. Not derived from `selectedId`: it is needed exactly
  // when that row is no longer in the list to look up.
  let selectedIndex = $state(0);
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

  type ModelState = PageData['models'][number];
  type Tone = 'live' | 'down' | 'neutral';
  const STATUS_TONE: Record<Tone, string> = {
    live: 'border-green-500/30 bg-green-500/10',
    down: 'border-red-500/30 bg-red-500/10',
    neutral: 'border-amber-500/30 bg-amber-500/10',
  };
  const reasonLabel = (key: string | null) =>
    MODEL_UNPUBLISH_REASONS.find((r) => r.value === key)?.label ?? key;
  const onDate = (iso: string | null) => (iso ? ` on ${fmtDate(iso)}` : '');

  /**
   * The model's state as a sentence. The enum alone misleads at exactly the moment it matters:
   * `Unpublished` is the OWNER's unpublish (a moderator's is `UnpublishedViolation`), and a taken-down
   * model can still read `Published` — `mode` sits on top of `status` rather than replacing it.
   * Checked in precedence order: deleted, then taken down, then the status itself.
   */
  function modelStatusView(m: ModelState): { tone: Tone; label: string; detail: string | null } {
    if (m.deleted) return { tone: 'down', label: 'Deleted', detail: null };
    if (m.mode === 'TakenDown')
      return { tone: 'down', label: `Taken down${onDate(m.takenDownAt)}`, detail: 'Hidden from the site.' };
    switch (m.status) {
      case 'Published':
        return {
          tone: 'live',
          label: 'Published — live on the site',
          detail: m.mode === 'Archived' ? 'Archived by its owner: visible, but no longer updated.' : null,
        };
      case 'UnpublishedViolation':
        return {
          tone: 'down',
          label: `Unpublished as a violation${onDate(m.unpublishedAt)}`,
          detail: m.unpublishedReason ? `Reason: ${reasonLabel(m.unpublishedReason)}` : null,
        };
      case 'Unpublished':
        return {
          tone: 'neutral',
          label: `Unpublished${onDate(m.unpublishedAt)}`,
          detail: 'Not live. Unpublished by its owner, not as a violation.',
        };
      default:
        return { tone: 'neutral', label: m.status, detail: 'Not live on the site.' };
    }
  }

  const ownerFlaggedMinor = $derived(new Set(data.ownerFlaggedMinor));
  const isOwnerFlaggedMinor = (entityId: number | null) =>
    entityId != null && ownerFlaggedMinor.has(entityId);

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
    moderateForm.error = null;
    unpublishReason = '';
    confirmingModel = null;
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

<!-- Queue on the left, the open report across the rest. Mods work one report at a time, so the report
     gets the room: a table across most of the width left the details squeezed into a column taller than
     the screen. The same shape as /retool/user-reports and /retool/post-reports. The page owns its
     height (`fullBleed`) so each column scrolls on its own and nothing is ever below the fold. -->
<div class="flex flex-col gap-4 px-6 pb-6 xl:h-[calc(100svh-3rem)] xl:flex-row xl:items-stretch">
  <section
    aria-label="Report queue"
    class="flex min-h-0 min-w-0 flex-col gap-3 xl:h-full xl:w-96 xl:shrink-0"
  >
    <header>
      <h1 class="m-0 text-xl font-semibold text-white">{reportEntityLabels[data.type]} reports</h1>
      <p class="m-0 text-sm text-dark-2">{data.totalItems} reports</p>
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

    <!-- Striped, and the open report marked with the same blue as the retool queues. The stripe is
         dropped on the open row rather than layered under it, so which wins never depends on
         Tailwind's variant order. `min-h-0` or the list refuses to shrink and the column overflows. -->
    <ul
      role="listbox"
      aria-label="Reports"
      class="flex flex-col gap-1 text-sm xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1"
    >
      {#each data.items as report (report.id)}
        {@const itemUrl = getReportItemUrl(data.civitaiUrl, data.type, report.entityId, report.contextUrl)}
        {@const isOpen = report.id === selected?.id}
        {@const modelName = data.models.find((m) => m.id === report.entityId)?.name}
        <li
          role="option"
          tabindex={0}
          aria-selected={isOpen}
          class="cursor-pointer rounded-md border px-3 py-2 {isOpen
            ? 'border-blue-500/40 bg-blue-500/15 shadow-[inset_3px_0_0_var(--color-blue-500)]'
            : 'border-transparent odd:bg-dark-7/40 hover:bg-dark-7/70'}"
          onclick={(e) => onRowClick(e, report.id)}
          onkeydown={(e) => onRowKeydown(e, report.id)}
        >
          <!-- Identity first: "which model is this about" used to cost a click or a trip to the site. -->
          <div class="flex items-baseline justify-between gap-2">
            <span class="min-w-0 truncate font-medium">
              {#if report.entityId == null}
                <span class="text-muted-foreground">—</span>
              {:else if itemUrl}
                <a href={itemUrl} target="_blank" rel="noreferrer" class="link">
                  {modelName ?? `#${report.entityId}`}
                </a>
              {:else}
                {modelName ?? `#${report.entityId}`}
              {/if}
            </span>
            <span class="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
              {fmtDate(report.createdAt)}
            </span>
          </div>
          <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <Badge class={reportStatusBadgeClass[report.status]}>{report.status}</Badge>
            <span>{report.reason}</span>
            {#if isOwnerFlaggedMinor(report.entityId)}<OwnerFlaggedMinorBadge />{/if}
            <span class="text-muted-foreground">
              by
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
                —
              {/if}
              <!-- Everyone else who filed the same report, folded in beside the filer. -->
              {#if report.alsoReportedByCount}
                <span
                  class="tabular-nums"
                  title={`Also reported by ${report.alsoReportedByCount} other ${report.alsoReportedByCount === 1 ? 'user' : 'users'}`}
                >
                  +{report.alsoReportedByCount}
                </span>
              {/if}
            </span>
          </div>
        </li>
      {:else}
        <li class="py-8 text-center text-muted-foreground">No reports match this view.</li>
      {/each}
    </ul>

    <!-- Prev/next rather than numbered pages, which do not fit a column this narrow. Buttons, not links:
         `navigate` also resets the open report to the new page's first. -->
    {#if totalPages > 1}
      <div class="flex items-center justify-between gap-2 text-sm">
        <Button
          size="sm"
          variant="ghost"
          disabled={data.page <= 1}
          onclick={() => navigate(urlWith({ page: data.page - 1 }))}
        >
          ← Previous
        </Button>
        <span class="text-muted-foreground">Page {data.page} of {totalPages}</span>
        <Button
          size="sm"
          variant="ghost"
          disabled={data.page >= totalPages}
          onclick={() => navigate(urlWith({ page: data.page + 1 }))}
        >
          Next →
        </Button>
      </div>
    {/if}
  </section>

  <section aria-label="Report details" class="flex min-w-0 flex-1 flex-col gap-3 xl:h-full xl:min-h-0">
    {#if selected}
      {@const itemUrl = getReportItemUrl(data.civitaiUrl, data.type, selected.entityId, selected.contextUrl)}
      <header class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 class="m-0 text-lg font-semibold">{reportEntityLabels[data.type]} report #{selected.id}</h2>
        {#if itemUrl}
          <a href={itemUrl} target="_blank" rel="noreferrer" class="link inline-flex items-center gap-1 text-sm">
            View {reportEntityLabels[data.type].toLowerCase()}{#if selected.entityId != null}
              #{selected.entityId}{/if}
            <IconExternalLink size={14} />
          </a>
        {/if}
        {#if isOwnerFlaggedMinor(selected.entityId)}<OwnerFlaggedMinorBadge />{/if}
      </header>

      <!-- Two columns: what is being judged on the left, the report and what to do about it on the right,
           each scrolling on its own so the actions never leave the screen. -->
      <div class="flex flex-col gap-4 xl:min-h-0 xl:flex-1 xl:flex-row">
        {#if selected.entityId != null}
          <div class="min-w-0 flex-1 rounded-xl border p-4 xl:overflow-y-auto">
            {#key selected.id}
              <ModelPreview modelId={selected.entityId} reportId={selected.id} civitaiUrl={data.civitaiUrl} />
            {/key}
          </div>
        {/if}
        <div
          class="flex min-w-0 flex-col gap-5 rounded-xl border p-4 xl:w-[26rem] xl:shrink-0 xl:overflow-y-auto"
        >
          <!-- 1. The report: what was said, by whom. -->
          <section aria-labelledby="report-heading" class="flex flex-col gap-2">
            <h3 id="report-heading" class="m-0 text-sm font-semibold">Report</h3>
            <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt class="text-muted-foreground">Reason</dt>
              <dd>{selected.reason}</dd>
              <dt class="text-muted-foreground">Reported by</dt>
              <dd>{selected.reportedByUsername ?? '—'}{selected.reason === 'Ownership' && selected.reportedByEmail ? ` (${selected.reportedByEmail})` : ''}{selected.alsoReportedByCount ? `, and ${selected.alsoReportedByCount} more` : ''}</dd>
              <dt class="text-muted-foreground">Reported</dt>
              <dd>{fmtDate(selected.createdAt)}</dd>
            </dl>
            {#if reportComment(selected)}
              <p class="wrap-break-word rounded-md border bg-muted/40 p-2 text-sm">{reportComment(selected)}</p>
            {/if}
            <!-- Collapsed: the preview is what gets read, and a 16rem JSON dump pushed it — and the
                 actions — off the panel. -->
            {#if selected.details}
              <details class="text-xs">
                <summary class="cursor-pointer text-muted-foreground">Raw report details</summary>
                <pre class="mt-2 max-h-64 overflow-auto rounded-lg border bg-muted/40 p-3">{JSON.stringify(
                    selected.details,
                    null,
                    2
                  )}</pre>
              </details>
            {/if}
          </section>

          {#if selected.entityId != null}
            {@const model = data.models.find((m) => m.id === selected.entityId)}
            {@const state = model ? modelStatusView(model) : null}

            <!-- 2. Where the model stands NOW. From the page load, which every action reloads, so this
                 is never the state from before the click. Said in words, not a raw enum: "Unpublished"
                 alone does not say whether the owner or a moderator did it, or why. -->
            <section aria-labelledby="model-status-heading" class="flex flex-col gap-2">
              <h3 id="model-status-heading" class="m-0 text-sm font-semibold">Model status</h3>
              {#if !model || !state}
                <p class="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                  This model no longer exists. Set the report status below.
                </p>
              {:else}
                <div class="rounded-md border p-3 {STATUS_TONE[state.tone]}">
                  <p class="m-0 text-sm font-medium">{state.label}</p>
                  {#if state.detail}<p class="m-0 mt-0.5 text-xs text-muted-foreground">{state.detail}</p>{/if}
                </div>
                <div class="flex flex-wrap items-center gap-1 text-xs">
                  {#if model.minor}<Badge variant="outline">Minor</Badge>{/if}
                  {#if model.sfwOnly}<Badge variant="outline">SFW-only</Badge>{/if}
                  {#if model.poi}<Badge variant="outline">Real person (POI)</Badge>{/if}
                  {#if model.nsfw}<Badge variant="outline">NSFW</Badge>{/if}
                  {#if !model.minor && !model.sfwOnly && !model.poi && !model.nsfw}
                    <span class="text-muted-foreground">No content flags.</span>
                  {/if}
                </div>
              {/if}
            </section>

            <!-- 3. What to do about it: the model page's moderator menu, cut down to what answers a report.
                 Each acts through the main app and then sets this report Actioned, so the trip to the site
                 and the trip back to close the report are both gone. Only actions that would CHANGE the
                 model are listed — a minor model is already SFW-only, a taken-down one is already down. There
                 is deliberately no delete: a report is answered by taking a model down, not by destroying
                 what it was about. -->
            {#if model && state && !model.deleted}
              {@const canUnpublish = model.status === 'Published'}
              {@const canFlagMinor = !model.minor}
              <!-- SFW-only stays listed when it is already set, disabled with the reason: a row that
                   vanished read as the action being unavailable rather than already done. -->
              {@const sfwDoneBecause = model.minor
                ? 'Already SFW-only: a minor model always is.'
                : model.sfwOnly
                  ? 'Already SFW-only.'
                  : null}
              {@const canTakeDown = model.mode !== 'TakenDown'}
              <section aria-labelledby="model-actions-heading" class="flex flex-col gap-3">
                <div>
                  <h3 id="model-actions-heading" class="m-0 text-sm font-semibold">Act on the model</h3>
                  <p class="m-0 text-xs text-muted-foreground">Each of these also marks this report Actioned.</p>
                </div>

                {#if canUnpublish}
                  <form
                    method="POST"
                    action="?/moderateModel"
                    use:enhance={moderateForm.enhance}
                    class="flex flex-col gap-2 rounded-md border p-3"
                  >
                    <input type="hidden" name="id" value={selected.id} />
                    <input type="hidden" name="modelAction" value="unpublish" />
                    <div>
                      <p class="m-0 text-sm font-medium">Unpublish as a violation</p>
                      <p class="m-0 text-xs text-muted-foreground">
                        Takes the model off the site and tells the owner why, using the reason below.
                      </p>
                    </div>
                    <select
                      name="reason"
                      bind:value={unpublishReason}
                      aria-label="Unpublish reason"
                      class="h-8 rounded-md border bg-background px-2 text-sm"
                    >
                      <option value="" disabled>Pick a reason…</option>
                      {#each MODEL_UNPUBLISH_REASONS as r (r.value)}
                        <option value={r.value}>{r.label}</option>
                      {/each}
                    </select>
                    {#if unpublishReason}
                      <Textarea
                        name="customMessage"
                        rows={2}
                        aria-label="Message to the owner"
                        placeholder={unpublishReason === 'other'
                          ? 'Message to the owner (required)'
                          : 'Extra message to the owner (optional)'}
                      />
                    {/if}
                    {#if unpublishReason && MINOR_UNPUBLISH_REASONS.has(unpublishReason) && !model.minor}
                      <!-- Defaults on, as the main app's unpublish dialog does: the reason says the model
                           depicts a minor, and the flag is the half that gets forgotten. -->
                      <label class="flex items-center gap-2 text-sm">
                        <Checkbox name="alsoFlagMinor" checked />
                        Also flag the model as depicting a minor
                      </label>
                    {/if}
                    <Button
                      type="submit"
                      size="sm"
                      variant="destructive"
                      class="self-start"
                      disabled={!unpublishReason || moderateForm.submitting}
                    >
                      Unpublish
                    </Button>
                  </form>
                {/if}

                <form
                  method="POST"
                  action="?/moderateModel"
                  use:enhance={moderateForm.enhance}
                  class="flex flex-col divide-y rounded-md border"
                >
                  <input type="hidden" name="id" value={selected.id} />
                  {#if canFlagMinor}
                    <div class="flex items-center justify-between gap-3 p-3">
                      <div>
                        <p class="m-0 text-sm font-medium">Flag as depicting a minor</p>
                        <p class="m-0 text-xs text-muted-foreground">
                          Marks the model and its images as minor, which also makes it SFW-only.
                        </p>
                      </div>
                      <Button
                        type="submit"
                        name="modelAction"
                        value="setMinor"
                        size="sm"
                        variant="outline"
                        disabled={moderateForm.submitting}
                      >
                        Flag minor
                      </Button>
                    </div>
                  {/if}
                  <div class="flex items-center justify-between gap-3 p-3">
                    <div>
                      <p class="m-0 text-sm font-medium {sfwDoneBecause ? 'text-muted-foreground' : ''}">
                        Make SFW-only
                      </p>
                      <p class="m-0 text-xs text-muted-foreground">
                        {sfwDoneBecause ??
                          'Rates the model SFW and limits its gallery to SFW images. The owner cannot undo it.'}
                      </p>
                    </div>
                    <Button
                      type="submit"
                      name="modelAction"
                      value="setSfwOnly"
                      size="sm"
                      variant="outline"
                      disabled={!!sfwDoneBecause || moderateForm.submitting}
                    >
                      Make SFW
                    </Button>
                  </div>
                  {#if canTakeDown}
                    <div class="flex items-center justify-between gap-3 p-3">
                      <div>
                        <p class="m-0 text-sm font-medium">Take down</p>
                        <p class="m-0 text-xs text-muted-foreground">
                          For ownership and claim reports. Hides the model as taken down; only a moderator
                          can bring it back.
                        </p>
                      </div>
                      {#if !data.grants['model.takeDown']}
                        <span class="max-w-32 text-right text-xs text-muted-foreground">
                          Needs the “Take down a model” permission
                        </span>
                      {:else if confirmingModel === `takeDown:${selected.id}`}
                        <div class="flex shrink-0 gap-1">
                          <Button
                            type="submit"
                            name="modelAction"
                            value="takeDown"
                            size="sm"
                            variant="destructive"
                            disabled={moderateForm.submitting}
                          >
                            Yes, take down
                          </Button>
                          <Button type="button" size="sm" variant="ghost" onclick={() => (confirmingModel = null)}>
                            Cancel
                          </Button>
                        </div>
                      {:else}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onclick={() => (confirmingModel = `takeDown:${selected.id}`)}
                        >
                          Take down
                        </Button>
                      {/if}
                    </div>
                  {/if}
                </form>

                {#if moderateForm.error}
                  <p class="text-sm text-red-300" role="alert">{moderateForm.error}</p>
                {/if}
              </section>
            {/if}
          {/if}

          <!-- 4. The report itself: Pending / Actioned / Unactioned. Named "Report status" — beside a
               model status, a bare "Status" read as the model's. -->
          <form method="POST" action="?/setStatus" use:enhance={statusForm.enhance} class="flex flex-col gap-2">
            <input type="hidden" name="id" value={selected.id} />
            <span class="text-sm font-semibold">Report status</span>
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
      </div>
    {:else}
      <!-- Only when the view itself is empty: `selected` falls back to a row whenever there is one. -->
      <section class="rounded-xl border border-dashed border-dark-4 p-5">
        <p class="text-sm text-dark-2">No reports in this view.</p>
      </section>
    {/if}
  </section>
</div>
