<script lang="ts">
  import { page } from '$app/state';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import { ARCHIVE_STATE_LABEL, ARCHIVE_STATE_VARIANT } from '$lib/csam-archive';
  import { csamReportUrl } from '$lib/entity-url';
  import { bytes, dateTime, LINK_CLASS, num, plural } from '$lib/format';
  import { urlWith } from '$lib/url';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const OUTCOME_LABEL = {
    running: 'Running',
    collected: 'Dry run',
    verified: 'Verified',
    failed: 'Verify failed',
    error: 'Error',
  } as const;
  const OUTCOME_VARIANT = {
    running: 'outline',
    collected: 'outline',
    verified: 'secondary',
    failed: 'destructive',
    error: 'destructive',
  } as const;

  const pageHref = (n: number) => urlWith(page.url, { page: n > 1 ? n : null });
  const reportHref = (id: number | null) => urlWith(page.url, { report: id, page: null });
  const totalBytes = (byItem: Record<string, { bytes: number }>) =>
    Object.values(byItem).reduce((sum, v) => sum + v.bytes, 0);
</script>

<div class="flex flex-col gap-3 px-6 pb-4">
  <h1 class="m-0 text-xl font-semibold text-white">CSAM archive</h1>
  <p class="m-0 text-sm text-dark-2">
    Where each sent report's evidence archive stands, from the csam-archiver. A report is Archived
    only after the archiver has verified every file and its lock. Counts only: this page never shows
    what was archived.
  </p>

  <h2 class="m-0 mt-2 text-base font-semibold text-white">
    Awaiting archive ({num(data.awaiting.total)})
  </h2>
  {#if data.awaiting.items.length === 0}
    <p class="m-0 text-sm text-dark-2">Every sent report is archived.</p>
  {:else}
    {#if data.awaiting.total > data.awaiting.items.length}
      <p class="m-0 text-xs text-dark-2">The {data.awaiting.items.length} oldest are shown.</p>
    {/if}
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Report</TableHead>
          <TableHead>User</TableHead>
          <TableHead>Sent</TableHead>
          <TableHead>Archive</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each data.awaiting.items as r (r.id)}
          <TableRow>
            <TableCell><a href={reportHref(r.id)} class={LINK_CLASS}>#{r.id}</a></TableCell>
            <TableCell>
              <a href={csamReportUrl(data.civitaiUrl, r.userId)} class={LINK_CLASS} target="_blank" rel="noreferrer">
                {r.username ?? `user #${r.userId}`}
              </a>
            </TableCell>
            <TableCell class="text-xs">{dateTime(r.reportSentAt)}</TableCell>
            <TableCell class="text-xs">
              <Badge variant={ARCHIVE_STATE_VARIANT[r.state]}>{ARCHIVE_STATE_LABEL[r.state]}</Badge>
              {#if r.attempts > 1}<span class="text-dark-2">{plural(r.attempts, 'attempt')}</span>{/if}
              {#if r.lastError}<code class="text-dark-2">{r.lastError}</code>{/if}
            </TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  {/if}

  <h2 class="m-0 mt-4 text-base font-semibold text-white">
    Runs
    {#if data.report}
      for report #{data.report}
      <a href={reportHref(null)} class="ml-2 text-sm font-normal {LINK_CLASS}">Show all</a>
    {/if}
  </h2>
  {#if data.runLogNotice}
    <p class="m-0 text-sm text-amber-300">{data.runLogNotice}</p>
  {:else if data.runs.length === 0}
    <p class="m-0 text-sm text-dark-2">
      {#if data.page > 1}
        Nothing on this page. <a href={pageHref(1)} class={LINK_CLASS}>Back to the first page</a>
      {:else}
        No runs recorded{data.report ? ' for this report' : ''}.
      {/if}
    </p>
  {:else}
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Started</TableHead>
          <TableHead>For</TableHead>
          <TableHead>User</TableHead>
          <TableHead>Outcome</TableHead>
          <TableHead class="text-right">Entries</TableHead>
          <TableHead class="text-right">Size</TableHead>
          <TableHead>Verify</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each data.runs as run (run.id)}
          <TableRow>
            <TableCell class="align-top text-xs">
              {dateTime(run.startedAt)}
              {#if run.archiverVersion}<div class="text-dark-2">{run.archiverVersion}</div>{/if}
            </TableCell>
            <TableCell class="align-top text-xs">
              {#if run.kind === 'report'}
                <a href={reportHref(run.reportId)} class={LINK_CLASS}>report #{run.reportId}</a>
              {:else}
                preservation <code>{run.preservationId}</code>
              {/if}
              {#if run.scope}<div class="text-dark-2">items {run.scope.join(', ')}</div>{/if}
            </TableCell>
            <TableCell class="align-top text-xs">
              {data.usernames[run.userId] ?? `user #${run.userId}`}
            </TableCell>
            <TableCell class="align-top text-xs">
              <div class="flex flex-wrap items-center gap-1">
                <Badge variant={OUTCOME_VARIANT[run.outcome]}>{OUTCOME_LABEL[run.outcome]}</Badge>
                {#if run.archived}<Badge variant="secondary">archivedAt set</Badge>{/if}
              </div>
              {#if run.error}<code class="text-dark-2">{run.error}</code>{/if}
            </TableCell>
            <TableCell class="align-top text-right text-xs tabular-nums">
              {#if run.summary}
                <details>
                  <summary class="cursor-pointer">
                    {num(run.summary.total)}
                    {#if run.summary.failed}<span class="text-red-300">· {num(run.summary.failed)} failed</span>{/if}
                  </summary>
                  <div class="mt-1 text-dark-2">
                    ok {num(run.summary.ok)} · planned {num(run.summary.planned)} · external
                    {num(run.summary.external)} · skipped items {num(run.summary.skipped)}
                  </div>
                  <ul class="m-0 mt-1 list-none p-0 text-dark-2">
                    {#each Object.entries(run.summary.byItem) as [item, v] (item)}
                      <li>item {item}: {num(v.entries)} entries, {num(v.rows)} rows</li>
                    {/each}
                  </ul>
                </details>
              {:else}
                <span class="text-dark-2">none</span>
              {/if}
            </TableCell>
            <TableCell class="align-top text-right text-xs tabular-nums">
              {run.summary ? bytes(totalBytes(run.summary.byItem) / 1024) : 'none'}
            </TableCell>
            <TableCell class="align-top text-xs">
              {#if run.verify}
                {run.verify.found} of {run.verify.expected}
                {#if run.verify.mismatches}<span class="text-red-300">· {num(run.verify.mismatches)} mismatched</span>{/if}
              {:else}
                <span class="text-dark-2">{run.mode === 'dry-run' ? 'not checked (dry run)' : 'none'}</span>
              {/if}
            </TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
    <nav class="flex gap-3 text-sm" aria-label="Pages">
      {#if data.page > 1}<a href={pageHref(data.page - 1)} class={LINK_CLASS}>Newer</a>{/if}
      {#if data.hasMore}<a href={pageHref(data.page + 1)} class={LINK_CLASS}>Older</a>{/if}
    </nav>
  {/if}
</div>
