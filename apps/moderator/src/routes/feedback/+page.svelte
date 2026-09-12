<script lang="ts">
  import { goto } from '$app/navigation';
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
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { MultiCombobox } from '@civitai/ui/components/ui/multi-combobox/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import CursorPager from '$lib/components/CursorPager.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { LINK_CLASS, dateTime, num, shortAge } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import { urlWith, urlWithMulti } from '$lib/url';
  import {
    FEEDBACK_STATUSES,
    feedbackAttachmentCount,
    feedbackStatusBadgeClass,
    splitContext,
  } from '$lib/feedback';
  import FeedbackDetail from './FeedbackDetail.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const statusOptions = FEEDBACK_STATUSES.map((s) => ({ value: s, label: s }));
  const areaLabel = $derived(data.area || 'Area — any');

  // `emptyMeansAll`: an ABSENT `status` falls back to the default view, so a cleared filter has to
  // survive as `?status=` or clearing it silently reapplies `new`.
  const applyStatus = (values: string[]) =>
    goto(urlWithMulti(clearedUrl(), 'status', values, { emptyMeansAll: true }));
  const applyArea = (value: string) => goto(urlWith(clearedUrl(), { area: value || null }));

  // Any filter change invalidates the keyset, and it closes the open row: the cursor points into a
  // result set that no longer exists, and `?open=` would name a row the new filters may exclude.
  function clearedUrl() {
    const next = new URL(page.url);
    next.searchParams.delete('cursor');
    next.searchParams.delete('open');
    return next;
  }

  const rowHref = (id: number) =>
    urlWith(page.url, { open: data.open === id ? null : id });
</script>

<header class="page-header">
  <h1>Feedback</h1>
  <p>
    In-product reports from the site's feedback prompts, newest first. Everything under
    <strong>Context</strong> is what the reporter's browser said — a claim, not evidence.
  </p>
</header>

<div class="mb-4 flex flex-wrap items-end gap-x-4 gap-y-3">
  <div class="flex flex-col gap-1">
    <Label for="feedback-status" class="text-xs text-dark-2">Status</Label>
    <MultiCombobox
      options={statusOptions}
      value={data.statuses}
      onValueChange={applyStatus}
      placeholder="Search statuses…"
    />
  </div>

  <div class="flex flex-col gap-1">
    <Label for="feedback-area" class="text-xs text-dark-2">Area</Label>
    <Select.Root type="single" value={data.area} onValueChange={applyArea}>
      <Select.Trigger id="feedback-area" class="w-56">{areaLabel}</Select.Trigger>
      <Select.Content>
        <Select.Item value="">Area — any</Select.Item>
        {#each data.areaOptions as option (option)}
          <Select.Item value={option}>{option}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>

  <span class="pb-1.5 text-xs text-dark-2">{num(data.items.length)} shown</span>
</div>

{#if data.open !== null && !data.openVisible}
  <p class="mb-4 text-sm text-dark-2">
    Report #{data.open} is not in this view — clear the filters to open it.
  </p>
{/if}

<div class="rounded-xl border border-dark-4">
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
              <a href={`${data.civitaiUrl}/issues`} target="_blank" rel="noreferrer" class={LINK_CLASS}>
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

<!-- The page-level `form` object carries a refusal raised on a row that a reload may have closed.
     Rendered here as well as in the panel so a denial is never invisible. -->
{#if form && 'error' in form && form.error}
  <ErrorAlert message={String(form.error)} class="mt-4" />
{/if}

<CursorPager href={data.nextCursor ? urlWith(page.url, { cursor: data.nextCursor, open: null }) : null} />
