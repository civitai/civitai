<script lang="ts">
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { MultiCombobox } from '@civitai/ui/components/ui/multi-combobox/index.js';
  import { DEFAULT_REPORT_STATUSES, reportReasonLabels, reportReasons, reportStatuses } from '$lib/reports';

  /**
   * The report queues' filters: status, reason and reporter, plus the reported-date range where a
   * queue reads it. One component so the model and user queues cannot drift into two sets of inputs.
   *
   * Writes the URL only; the caller's `navigate` decides what else a new view resets (the open model,
   * the open account, the image page). Every change lands on page 1.
   *
   * Params, which each page's `load` reads: `status` and `reason` repeat, and a present-but-EMPTY one
   * means "all" while an absent one means the default view — so a cleared selection is written as an
   * empty param rather than removed. `reportedBy` is a username prefix; `reportedFrom`/`reportedTo` are
   * `YYYY-MM-DD`.
   */
  let {
    statuses,
    reasons,
    reportedBy,
    hidingAutomated,
    statusCounts,
    dates,
    navigate,
    compact = false,
    extra,
  }: {
    statuses: string[];
    /** The reasons the URL names. Empty while the default is applied — eight pre-ticked chips read as a
     *  heavily narrowed view when it is the ordinary one, so `hidingAutomated` says it instead. */
    reasons: string[];
    reportedBy: string;
    hidingAutomated: boolean;
    /** Open reports per status under the other filters. Shown on each status, in place of one total across
     *  the selected ones — the sidebar badge counts Pending alone, and a total over Pending + Processing
     *  read as the badge being wrong. */
    statusCounts: Partial<Record<string, number>>;
    /** Shown only for a queue whose `load` filters on the reported date. */
    dates?: { from: string; to: string };
    navigate: (href: string) => void;
    /** For a sidebar: status and reason only, the reporter and dates behind "Additional filters". */
    compact?: boolean;
    /** The caller's own filters, under Reason in the compact layout. */
    extra?: Snippet;
  } = $props();

  let showMore = $state(false);
  const activeMore = $derived([reportedBy, dates?.from, dates?.to].filter(Boolean).length);

  const statusOptions = $derived(
    // Counted statuses only — the open ones (see `getReportStatusCounts`). Resolved ones go unnumbered
    // rather than reading 0.
    reportStatuses.map((s) => ({
      value: s,
      label: s in statusCounts || DEFAULT_REPORT_STATUSES.includes(s) ? `${s} (${(statusCounts[s] ?? 0).toLocaleString()})` : s,
    }))
  );
  const reasonOptions = reportReasons.map((r) => ({ value: r, label: reportReasonLabels[r] }));

  function hrefWith(edit: (params: URLSearchParams) => void) {
    const url = new URL(page.url);
    edit(url.searchParams);
    url.searchParams.set('page', '1');
    return url.pathname + url.search;
  }

  function applyMulti(key: string, values: string[]) {
    navigate(
      hrefWith((p) => {
        p.delete(key);
        if (values.length === 0) p.set(key, '');
        else values.forEach((v) => p.append(key, v));
      })
    );
  }

  function applyText(e: SubmitEvent) {
    e.preventDefault();
    const form = new FormData(e.currentTarget as HTMLFormElement);
    navigate(
      hrefWith((p) => {
        for (const key of ['reportedBy', 'reportedFrom', 'reportedTo']) {
          const value = String(form.get(key) ?? '').trim();
          if (value) p.set(key, value);
          else p.delete(key);
        }
      })
    );
  }
</script>

{#if compact}
  <div class="flex flex-col gap-1.5">
    <MultiCombobox
      options={statusOptions}
      value={statuses}
      onValueChange={(vals) => applyMulti('status', vals)}
      placeholder="Status…"
    />
    <MultiCombobox
      options={reasonOptions}
      value={reasons}
      onValueChange={(vals) => applyMulti('reason', vals)}
      placeholder="Reason…"
    />
    {#if extra}{@render extra()}{/if}
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <button
        type="button"
        class="underline-offset-2 hover:underline"
        aria-expanded={showMore}
        onclick={() => (showMore = !showMore)}
      >
        {showMore ? '▾' : '▸'} Additional filters{activeMore ? ` · ${activeMore}` : ''}
      </button>
      {#if hidingAutomated}
        <span title="This queue and its badge both count only reports people filed.">
          Automated hidden ·
          <button type="button" class="underline" onclick={() => applyMulti('reason', [])}>show</button>
        </span>
      {/if}
    </div>
    {#if showMore}
      <form class="flex flex-col gap-1.5" onsubmit={applyText}>
        <Input
          name="reportedBy"
          value={reportedBy}
          placeholder="Reported by (username)"
          aria-label="Reported by"
          class="h-8 w-full"
        />
        <div class="flex items-center gap-1.5">
          {#if dates}
            <Input type="date" name="reportedFrom" value={dates.from} aria-label="Reported from" class="h-8 min-w-0 flex-1" />
            <span class="text-xs text-muted-foreground">to</span>
            <Input type="date" name="reportedTo" value={dates.to} aria-label="Reported to" class="h-8 min-w-0 flex-1" />
          {/if}
          <Button type="submit" size="sm" variant="outline" class="shrink-0">Search</Button>
        </div>
      </form>
    {/if}
  </div>
{:else}
<div class="flex flex-wrap items-end gap-x-6 gap-y-3">
  <div class="flex flex-col gap-1">
    <span class="text-xs font-medium text-muted-foreground">Status</span>
    <MultiCombobox
      options={statusOptions}
      value={statuses}
      onValueChange={(vals) => applyMulti('status', vals)}
      placeholder="Search statuses…"
    />
  </div>

  <div class="flex flex-col gap-1">
    <span class="text-xs font-medium text-muted-foreground">Reason</span>
    <MultiCombobox
      options={reasonOptions}
      value={reasons}
      onValueChange={(vals) => applyMulti('reason', vals)}
      placeholder="Search reasons…"
    />
  </div>

  <!-- One form, one Search: typing a reporter and a date range is one question, not three. -->
  <form class="flex flex-wrap items-end gap-x-2 gap-y-3" onsubmit={applyText}>
    <div class="flex flex-col gap-1">
      <span class="text-xs font-medium text-muted-foreground">Reported by</span>
      <Input name="reportedBy" value={reportedBy} placeholder="username" class="h-8 w-40" />
    </div>
    {#if dates}
      <div class="flex flex-col gap-1">
        <span class="text-xs font-medium text-muted-foreground">From</span>
        <Input type="date" name="reportedFrom" value={dates.from} class="h-8 w-36" />
      </div>
      <div class="flex flex-col gap-1">
        <span class="text-xs font-medium text-muted-foreground">To</span>
        <Input type="date" name="reportedTo" value={dates.to} class="h-8 w-36" />
      </div>
    {/if}
    <Button type="submit" size="sm" variant="outline">Search</Button>
  </form>
</div>

{#if hidingAutomated}
  <p class="m-0 text-xs text-muted-foreground">
    Automated reports are hidden — this queue and its badge both count only reports people filed.
    <button type="button" class="underline" onclick={() => applyMulti('reason', [])}>
      Show automated reports
    </button>
  </p>
{/if}
{/if}
