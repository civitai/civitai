<script lang="ts" generics="R extends ReportListItem">
  import type { Snippet } from 'svelte';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { IconChevronRight } from '@tabler/icons-svelte';
  import { dateTime } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import {
    isReportRuling,
    reportDetail,
    reportReasonLabel,
    reportStatusBadgeClass,
  } from '$lib/reports';
  import ReportNotes from './ReportNotes.svelte';
  import ReportStatusButtons from './ReportStatusButtons.svelte';
  import type { ReportListItem } from './report-list';

  /**
   * Every report about the open item, one line each: the reason, who filed it, when, its status, and
   * its ruling beside it. One row is open at a time and shows the rest — the reporters' own words (the
   * filer's, and each folded-in reporter's) and the raw details — so an item with several reports grows the column by a line per report rather
   * than by a block per report.
   *
   * Each report keeps its own ruling: reports about one item can need different answers (an ownership
   * claim upheld, a TOS report on the same model not).
   */
  let {
    reports,
    canRule,
    action,
    onSubmit,
    busyId = null,
    error = null,
    details,
    empty,
    statuses,
  }: {
    reports: R[];
    canRule: boolean;
    /** The ruling's form action, e.g. `?/setStatus`. */
    action: string;
    onSubmit: SubmitFunction;
    /** The report whose ruling is in flight, so one ruling does not disable every row. */
    busyId?: number | null;
    error?: string | null;
    /** More for the open row, under the report's own details and above its notes — the model
     *  queue's merge-permission check. */
    details?: Snippet<[R]>;
    /** Shown when the item has no reports to list. */
    empty: Snippet;
    /** The statuses the queue can set; the outcomes only unless given (`ReportStatusButtons`). */
    statuses?: readonly string[];
  } = $props();

  // The first row opens by default: with one report — the usual case — the column reads as it did
  // before there were rows at all. A row that leaves the list (ruled on, out of the view) falls back to
  // the first. `null` is every row closed, which only a click on the open row asks for.
  let openId = $state<number | null | undefined>(undefined);
  // Where the open row sat, for when it leaves the list: the row that slid into its place opens.
  let openIndex = 0;
  const shown = $derived(
    openId === null
      ? null
      : (reports.find((r) => r.id === openId)?.id ??
          reports[Math.min(openIndex, reports.length - 1)]?.id ??
          null)
  );

  function select(id: number, isOpen: boolean) {
    openId = isOpen ? null : id;
    openIndex = Math.max(0, reports.findIndex((r) => r.id === id));
  }

  /**
   * A ruling moves on to the next report still open, as the queue moved on to the next row — ruling
   * on several reports about one item is one pass down the list, not a click to open each. Wraps the
   * page's enhancer, which still owns the write, the reload and the refusal.
   */
  const rule: SubmitFunction = async (input) => {
    const id = Number(input.formData.get('id'));
    // Only an outcome moves on. Setting Processing (where a queue still offers it) says the moderator is
    // working this one, and jumping away from it would undo that.
    const ruled = isReportRuling(String(input.formData.get('status')));
    // Captured now: by the time the write lands the list has reloaded, and the ruled row may be gone.
    const from = Math.max(0, reports.findIndex((r) => r.id === id));
    const after = await onSubmit(input);
    return async (opts) => {
      if (typeof after === 'function') await after(opts);
      else await opts.update();
      if (opts.result.type !== 'success' || !ruled) return;
      const rest = [...reports.slice(from), ...reports.slice(0, from)];
      const next = rest.find((r) => r.id !== id && (r.status === 'Pending' || r.status === 'Processing'));
      openId = next?.id;
      openIndex = from;
    };
  };
</script>

<!-- `lookup` is what User Lookup resolves — a username, or the id of an account that no longer has
     one. Linking the "#123" label instead searched for the string "#123". -->
{#snippet said(label: string | null, lookup: string | number | null, at: string | null, words: string | null)}
  <div class="rounded-md border bg-muted/40 p-2 text-sm">
    <p class="m-0 text-xs text-muted-foreground">
      {#if label && lookup != null}<a href={userLookupUrl(lookup)} class="link">{label}</a>{:else}—{/if}{at
        ? ` · ${dateTime(at)}`
        : ''}
    </p>
    <p class="m-0 mt-0.5 wrap-break-word">
      {#if words}{words}{:else}<span class="text-muted-foreground">No comment.</span>{/if}
    </p>
  </div>
{/snippet}

<section aria-labelledby="reports-heading" class="flex flex-col gap-2">
  <h3 id="reports-heading" class="m-0 text-sm font-semibold">
    {reports.length > 1 ? `Reports (${reports.length})` : 'Report'}
  </h3>

  {#if reports.length}
    <ul class="m-0 flex list-none flex-col divide-y rounded-lg border p-0">
      {#each reports as r (r.id)}
        {@const isOpen = r.id === shown}
        {@const comment = reportDetail(r.details, 'comment')}
        <li class="flex flex-col gap-2 p-2.5">
          <!-- Nothing truncated: a reason or a username cut to "TOS Viol…" is the part being read. The
               reason wraps on the first line, who and when on the second, and a closed row's ruling
               sits at the end of that line, dropping below it when the column is too narrow. -->
          <div class="flex items-start gap-2">
            <button
              type="button"
              class="flex min-w-0 flex-1 items-start gap-1.5 text-left text-sm"
              aria-expanded={isOpen}
              onclick={() => select(r.id, isOpen)}
            >
              <IconChevronRight
                size={14}
                class="mt-0.5 shrink-0 text-muted-foreground transition-transform {isOpen ? 'rotate-90' : ''}"
              />
              <span class="min-w-0 wrap-break-word font-medium">
                {reportReasonLabel(r.details, r.reason)}
              </span>
            </button>
            <Badge class="shrink-0 {reportStatusBadgeClass[r.status as keyof typeof reportStatusBadgeClass]}">
              {r.status}
            </Badge>
          </div>
          {#if !isOpen}
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-5">
              <span class="min-w-0 wrap-break-word text-xs text-muted-foreground">
                {r.reportedByUsername ?? '—'}{r.alsoReportedByCount
                  ? ` +${r.alsoReportedByCount}`
                  : ''} · {dateTime(r.createdAt)}
              </span>
              {#if canRule}
                <div class="ml-auto">
                  <ReportStatusButtons
                    reportId={r.id}
                    status={r.status}
                    {action}
                    onSubmit={rule}
                    busy={busyId === r.id}
                    size="xs"
                    {statuses}
                  />
                </div>
              {/if}
            </div>
          {/if}

          {#if isOpen}
            <div class="flex flex-col gap-2 pl-5">
              <p class="m-0 text-xs text-muted-foreground">
                Reported by
                {#if r.reportedByUsername}
                  <a href={userLookupUrl(r.reportedByUsername)} class="link">{r.reportedByUsername}</a>
                {:else}
                  —
                {/if}{r.reason === 'Ownership' && r.reportedByEmail
                  ? ` (${r.reportedByEmail})`
                  : ''}{r.alsoReportedByCount ? `, and ${r.alsoReportedByCount} more` : ''}, {dateTime(
                  r.createdAt
                )}
              </p>
              <!-- One block per reporter, each saying who wrote it: the others are folded into the one
                   report, and their words were reachable only through the raw details. -->
              {#if comment}
                {@render said(r.reportedByUsername, r.reportedByUsername, null, comment)}
              {/if}
              {#each r.additionalReporters ?? [] as a, i (`${a.userId}:${i}`)}
                {@render said(a.username ?? `#${a.userId}`, a.username ?? a.userId, a.createdAt, a.comment)}
              {/each}
              <!-- Collapsed: the evidence is what gets read, and a 16rem JSON dump pushed it — and the
                   actions — off the column. -->
              {#if r.details}
                <details class="text-xs">
                  <summary class="cursor-pointer text-muted-foreground">Raw report details</summary>
                  <pre class="mt-2 max-h-64 overflow-auto rounded-lg border bg-muted/40 p-3">{JSON.stringify(
                      r.details,
                      null,
                      2
                    )}</pre>
                </details>
              {/if}
              {#if canRule}
                <ReportStatusButtons
                  reportId={r.id}
                  status={r.status}
                  {action}
                  onSubmit={rule}
                  busy={busyId === r.id}
                  {statuses}
                />
              {/if}
              {#if details}{@render details(r)}{/if}
              <!-- Every queue's, posting to its `?/saveNotes`: editable by whoever can rule, read by
                   everyone else. The keyed `each` gives each report its own, so a half-typed note
                   never carries to another. -->
              <ReportNotes reportId={r.id} notes={r.internalNotes} canEdit={canRule} />
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    {@render empty()}
  {/if}
  {#if error}<p class="m-0 text-sm text-red-300" role="alert">{error}</p>{/if}
</section>
