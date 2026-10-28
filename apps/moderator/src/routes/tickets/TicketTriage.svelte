<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { IconZoomCancel } from '@tabler/icons-svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import TriagePageHeader from '$lib/components/triage/TriagePageHeader.svelte';
  import TriageShell from '$lib/components/triage/TriageShell.svelte';
  import { LINK_CLASS, dateTime, shortAge } from '$lib/format';
  import type { TicketPageResult, TicketRow } from '$lib/server/tickets/list';
  import { syncedAgo } from '$lib/tickets/filters';
  import { requesterLabel, rowChip, sentByText } from '$lib/tickets/row';
  import type { TicketView } from '$lib/tickets/routing';
  import { urlWith } from '$lib/url';
  import TicketFilterBar from './TicketFilterBar.svelte';
  import TicketStatusBadge from './TicketStatusBadge.svelte';
  import TicketTriageDetail from './TicketTriageDetail.svelte';

  type Data = {
    view: TicketView;
    result: TicketPageResult;
    selectedMissing: string | null;
    canReply: boolean;
    canEscalate: boolean;
    canAccountAct: boolean;
    canUnban: boolean;
  };

  let { data, form }: { data: Data; form: { error?: string } | null | undefined } = $props();

  const SELECTION = 'ticket';
  const DROP_ON_CHANGE = ['page', SELECTION];
  const TITLES: Record<TicketView, { title: string; subtitle: string }> = {
    moderation: {
      title: 'Moderation tickets',
      subtitle: 'Live tickets about appeals, bans, restrictions and moderator decisions.',
    },
    support: {
      title: 'Support tickets',
      subtitle: 'Every other live ticket, including those moderators sent over.',
    },
  };

  const ok = $derived(data.result.status === 'ok' ? data.result : null);
  const failure = $derived(data.result.status === 'unavailable' ? data.result.reason : null);
  const query = $derived(ok?.query);

  // Set on the client only: a clock read during SSR would differ from the one at hydration.
  let now = $state<number | null>(null);
  // A refusal that never ran through enhance (no JS) is shown here; with JS each form shows its own.
  let hydrated = $state(false);
  onMount(() => {
    hydrated = true;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  const filtersActive = $derived(
    !!query &&
      (query.status.length > 0 ||
        query.feature.length > 0 ||
        query.topic.length > 0 ||
        query.sent !== undefined ||
        query.q !== '')
  );
  // Every filter, the search and the sort live in the query string, so the bare path clears them all.
  const clearHref = $derived(page.url.pathname);

  // Moving on after the open ticket left the list (it changed view, or was resolved): the next one,
  // else the one before, with the list read again so the ticket is gone from it.
  function leave(id: string) {
    const rows = ok ? [...ok.items, ...(ok.pinned ? [ok.pinned] : [])] : [];
    const at = rows.findIndex((r) => r.id === id);
    const next = at === -1 ? rows[0] : (rows[at + 1] ?? rows[at - 1]);
    void goto(urlWith(page.url, { [SELECTION]: next?.id ?? null }), {
      invalidateAll: true,
      noScroll: true,
      keepFocus: true,
    });
  }
</script>

{#snippet meta()}
  {#if ok && now !== null}
    <p class="m-0 mt-0.5 text-xs text-dark-2" title={dateTime(new Date(ok.syncedAt))}>
      Read from Freshdesk {syncedAgo(ok.syncedAt, now)}
    </p>
  {/if}
{/snippet}

{#snippet notice({ unpicked }: { unpicked: boolean })}
  {#each ok?.warnings ?? [] as warning, i (i)}
    <p class="mx-6 mt-3 mb-0 rounded-lg border border-amber-700 bg-dark-6 p-3 text-sm text-amber-300">
      {warning}
    </p>
  {/each}
  {#if form?.error && !hydrated}
    <ErrorAlert class="mx-6 mt-3" message={form.error} />
  {/if}
  {#if data.selectedMissing && (unpicked || !hydrated)}
    <ErrorAlert
      class="mx-6 mt-3"
      message="Ticket #{data.selectedMissing} is not a live {data.view} ticket. It may be resolved, in the other view, or too new to be listed yet."
    />
  {/if}
{/snippet}

{#snippet listHeader()}
  {#if ok}
    <TicketFilterBar view={data.view} result={ok} dropOnChange={DROP_ON_CHANGE} />
  {/if}
{/snippet}

<!-- The shell renders this in the list and again in the detail pane when nothing matches; the
     `in-[...]` variants pick the half that belongs to the pane it landed in. -->
{#snippet empty()}
  <div
    class="flex h-full flex-col items-center justify-center gap-1 p-5 text-center text-sm text-dark-0 in-[section]:hidden"
  >
    <IconZoomCancel class="mb-1.5 size-5 text-dark-2" aria-hidden="true" />
    <p class="m-0 font-medium text-white">
      {#if query?.q}
        No tickets match "{query.q}"
      {:else if filtersActive}
        No tickets match these filters
      {:else}
        No live tickets in this view
      {/if}
    </p>
    {#if query?.q}
      <p class="m-0 text-xs text-dark-2">Search matches a ticket number, subject or requester name.</p>
    {/if}
    {#if filtersActive}
      <a href={clearHref} class="text-xs {LINK_CLASS}">Clear filters</a>
    {/if}
  </div>
  <p class="m-0 hidden text-sm text-dark-2 in-[section]:block">Select a ticket to read it.</p>
{/snippet}

<div class="flex flex-col lg:h-svh">
  <TriagePageHeader
    title={TITLES[data.view].title}
    subtitle={TITLES[data.view].subtitle}
    placeholder="Ticket #, subject or requester name"
    searchLabel="Search tickets"
    {meta}
  />
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
    {#if ok}
      <TriageShell
        flush
        rows={ok.items}
        rowKey={(row: TicketRow) => row.id}
        parseKey={(raw) => (/^\d+$/.test(raw) ? raw : null)}
        selectionParam={SELECTION}
        queueLabel="Ticket queue"
        itemLabel="Ticket"
        decisionEnabled={() => []}
        pinned={ok.pinned}
        pageNumber={ok.page}
        hasMore={ok.hasMore}
        offset={ok.offset}
        total={ok.total}
        {notice}
        {listHeader}
        {empty}
      >
        {#snippet listRow(row, state)}
          {@const chip = rowChip(row)}
          {@const sent = sentByText(row)}
          <li id={state.id}>
            <a
              href={state.href}
              onclick={(e) => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                state.select();
              }}
              aria-current={state.selected ? 'true' : undefined}
              class="block border-l-2 px-3 py-2.5 transition-colors hover:bg-dark-5 {state.selected
                ? 'border-blue-500 bg-dark-5'
                : 'border-transparent'}"
            >
              <div class="flex items-baseline justify-between gap-2">
                <span class="flex min-w-0 items-baseline gap-1.5">
                  <span class="shrink-0 text-xs text-dark-2 tabular-nums">#{row.id}</span>
                  <span class="truncate text-sm font-medium text-white">
                    {row.subject || '(no subject)'}
                  </span>
                </span>
                <span
                  class="shrink-0 text-xs text-dark-2 tabular-nums"
                  title={dateTime(row.updatedAt)}
                >
                  {row.updatedAt ? `${shortAge(row.updatedAt)} ago` : '—'}
                </span>
              </div>
              <div class="mt-1.5 flex min-w-0 items-center gap-1.5">
                <TicketStatusBadge status={row.status} label={row.statusLabel} />
                {#if chip}
                  <span
                    class="truncate text-xs {chip.inferred ? 'text-dark-2 italic' : 'text-dark-1'}"
                    title={chip.inferred ? `Router topic: ${chip.label}` : chip.label}
                  >
                    {chip.label}
                  </span>
                {/if}
              </div>
              <p class="m-0 mt-1 truncate text-xs text-dark-2">
                {sent ? `${requesterLabel(row)} · ${sent}` : requesterLabel(row)}
              </p>
            </a>
          </li>
        {/snippet}
        {#snippet detail(row)}
          <TicketTriageDetail
            {row}
            view={data.view}
            canReply={data.canReply}
            canEscalate={data.canEscalate}
            canAccountAct={data.canAccountAct}
            canUnban={data.canUnban}
            onleave={leave}
          />
        {/snippet}
      </TriageShell>
    {:else}
      <div class="m-6">
        <ErrorAlert message="Could not read tickets: {failure}" />
        <p class="m-0 mt-2 text-sm text-dark-2">Reload the page to try again.</p>
      </div>
    {/if}
  </div>
</div>
