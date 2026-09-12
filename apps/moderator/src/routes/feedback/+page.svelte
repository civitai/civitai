<script lang="ts">
  import { page } from '$app/state';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import CursorPager from '$lib/components/CursorPager.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { LINK_CLASS, dateTime, shortAge } from '$lib/format';
  import { issuesUrl, userLookupUrl } from '$lib/entity-url';
  import { urlWith } from '$lib/url';
  import {
    feedbackAttachmentCount,
    feedbackStatusBadgeClass,
    splitContext,
  } from '$lib/feedback';
  import FeedbackFilters from './FeedbackFilters.svelte';
  import FeedbackDetail from './FeedbackDetail.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const rowHref = (id: number) => urlWith(page.url, { open: data.open === id ? null : id });

  /**
   * 🔴 THE ONLY SURFACE A REFUSAL HAS WHEN THE PANEL IS NOT MOUNTED, which is exactly when the
   * important ones happen. `FormState` awaits `update({ invalidateAll })` BEFORE assigning its own
   * `error`, so a 410 (the row was deleted) or a 409 that moves the row out of the active status
   * filter has already dropped the row from `data.items` — the panel is unmounted and its message
   * is written to a dead instance. A no-JS submit has no panel at all, because posting to
   * `?/triage` replaces the query string and takes `?open=` with it.
   *
   * Gated on `openVisible` so a refusal the panel CAN still show is not rendered twice.
   */
  const pageError = $derived(
    !data.openVisible && form && 'error' in form && form.error ? String(form.error) : null
  );
</script>

<header class="page-header">
  <h1>Feedback</h1>
  <p>
    In-product reports from the site's feedback prompts, newest first. Everything under
    <strong>Context</strong> is what the reporter's browser said — a claim, not evidence.
  </p>
</header>

<FeedbackFilters
  statuses={data.statuses}
  area={data.area}
  areaOptions={data.areaOptions}
  shown={data.items.length}
/>

{#if pageError}
  <ErrorAlert message={pageError} class="mb-4" />
{:else if data.open !== null && !data.openVisible}
  <!-- Only when there is no refusal to show: "clear the filters" is the wrong advice for a row that
       was just deleted, and that is the case where both would otherwise render. -->
  <p class="mb-4 text-sm text-dark-2">
    Report #{data.open} is not in this view — clear the filters to open it.
  </p>
{/if}

<div class="rounded-xl border border-dark-4 bg-dark-6">
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Age</TableHead>
        <TableHead>Area</TableHead>
        <TableHead>User</TableHead>
        <TableHead>Message</TableHead>
        <TableHead class="text-right">📎</TableHead>
        <TableHead>Status</TableHead>
        <TableHead>Handled</TableHead>
        <TableHead>Issue</TableHead>
        <TableHead class="w-px"></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each data.items as row (row.id)}
        {@const context = splitContext(row.context)}
        {@const attachments = feedbackAttachmentCount(context)}
        {@const open = data.open === row.id}
        <TableRow>
          <TableCell class="whitespace-nowrap tabular-nums" title={dateTime(row.createdAt)}>
            {shortAge(row.createdAt)}
          </TableCell>
          <TableCell><Badge variant="outline">{row.area}</Badge></TableCell>
          <TableCell>
            {#if row.username}
              <a href={userLookupUrl(row.username)} class={LINK_CLASS}>{row.username}</a>
            {:else}
              <span class="text-dark-2">#{row.userId}</span>
            {/if}
          </TableCell>
          <TableCell class="max-w-md">
            <span class="line-clamp-1 text-sm text-dark-2" title={row.message}>{row.message}</span>
          </TableCell>
          <TableCell class="text-right tabular-nums text-dark-2">{attachments || ''}</TableCell>
          <TableCell>
            <Badge class={feedbackStatusBadgeClass(row.status)}>{row.status}</Badge>
          </TableCell>
          <TableCell class="whitespace-nowrap text-sm text-dark-2">
            {row.handledByUsername ?? (row.handledAt ? 'deleted account' : '—')}
          </TableCell>
          <TableCell class="whitespace-nowrap tabular-nums">
            {#if row.bugId}
              <a
                href={issuesUrl(data.civitaiUrl)}
                target="_blank"
                rel="noreferrer"
                class={LINK_CLASS}
              >
                #{row.bugId}
              </a>
            {:else}
              <span class="text-dark-2">—</span>
            {/if}
          </TableCell>
          <TableCell>
            <a href={rowHref(row.id)} class={LINK_CLASS} aria-expanded={open}>
              {open ? 'Close' : 'Open'}
            </a>
          </TableCell>
        </TableRow>
        {#if open}
          <TableRow>
            <TableCell colspan={9} class="bg-dark-7/40 p-0">
              <FeedbackDetail
                {row}
                {context}
                siblings={data.siblings}
                grafanaUrl={data.grafanaUrl}
                civitaiUrl={data.civitaiUrl}
                canTriage={!!data.grants['feedback.status.set']}
                canPromote={!!data.grants['feedback.bug.promote']}
              />
            </TableCell>
          </TableRow>
        {/if}
      {:else}
        <TableRow>
          <TableCell colspan={9} class="py-8 text-center text-dark-2">
            No feedback matches this view.
          </TableCell>
        </TableRow>
      {/each}
    </TableBody>
  </Table>
</div>

<CursorPager
  href={data.nextCursor ? urlWith(page.url, { cursor: data.nextCursor, open: null }) : null}
/>
