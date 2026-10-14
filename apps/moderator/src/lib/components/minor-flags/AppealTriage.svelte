<script lang="ts">
  import { invalidateAll, replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { SvelteMap } from 'svelte/reactivity';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { LINK_CLASS, num } from '$lib/format';
  import { optimisticEnhancer } from '$lib/form-action';
  import { appealFilterParams } from '$lib/minor-flags/appeal-filters';
  import {
    formActionHref,
    isTypingTarget,
    nextUndecided,
    step,
    triageKeyAction,
  } from '$lib/minor-flags/appeal-triage';
  import type { AppealQueueData } from '$lib/server/minor-flag-queue';
  import { urlWith } from '$lib/url';
  import AppealDetail from './AppealDetail.svelte';
  import AppealQueueList from './AppealQueueList.svelte';

  type QueueForm = { error?: string; rescanQueued?: boolean; modelId?: number } | null;

  let {
    data,
    form,
  }: { data: AppealQueueData & { civitaiUrl: string }; form: QueueForm | undefined } = $props();

  const rows = $derived(data.items);
  const ids = $derived(rows.map((r) => r.appealId));

  let selectedId = $state<number | null>(Number(page.url.searchParams.get('appeal')) || null);
  const selected = $derived(rows.find((r) => r.appealId === selectedId) ?? rows[0]);

  // appealId → outcome. Optimistic: the row dims and states the result. Cleared whenever the queue
  // itself changes, so a stale mark can never describe a different appeal.
  const acted = new SvelteMap<number, string>();
  $effect(() => {
    data.items;
    acted.clear();
  });

  // `page.url` does not follow a shallow `replaceState`, so the selection is its own state and the
  // address bar only mirrors it.
  function select(appealId: number) {
    selectedId = appealId;
    replaceState(urlWith(page.url, { appeal: appealId }), page.state);
  }

  $effect(() => {
    if (selected)
      document.getElementById(`appeal-${selected.appealId}`)?.scrollIntoView({ block: 'nearest' });
  });

  const advance = (decidedId: number) => {
    if (selected?.appealId !== decidedId) return;
    const next = nextUndecided(ids, decidedId, (id) => acted.has(id));
    if (next !== null) select(next);
  };

  const submit = (appealId: number, verdict: string): SubmitFunction => {
    const decide = optimisticEnhancer(() => {
      acted.set(appealId, verdict);
      return () => acted.delete(appealId);
    });
    return async (input) => {
      const finish = await decide(input);
      return async (outcome) => {
        await finish?.(outcome);
        if (outcome.result.type === 'success') advance(appealId);
      };
    };
  };

  // A no-JS submit lands on the action URL, so it carries the page's query to render the same queue.
  const actionHref = (action: string) =>
    formActionHref(action, {
      ...appealFilterParams(data.appealFilters),
      q: data.q,
      page: data.page > 1 ? data.page : undefined,
      limit: page.url.searchParams.get('limit') ?? undefined,
    });

  let upholdForm = $state<HTMLFormElement>();
  let overturnForm = $state<HTMLFormElement>();

  function onkeydown(e: KeyboardEvent) {
    const action = triageKeyAction({
      key: e.key,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      typing: isTypingTarget(e.target),
    });
    if (!action) return;
    e.preventDefault();
    if (action === 'next' || action === 'previous') {
      const to = step(ids, selected?.appealId ?? null, action === 'next' ? 1 : -1);
      if (to !== null) select(to);
    } else if (!e.repeat) {
      (action === 'uphold' ? upholdForm : overturnForm)?.requestSubmit();
    }
  }

  const pageHref = (n: number) => urlWith(page.url, { page: n, appeal: null });
  const clearFiltersHref = $derived(
    urlWith(page.url, { source: null, flag: null, sort: null, page: null, appeal: null })
  );
  const filtersActive = $derived(Object.keys(appealFilterParams(data.appealFilters)).length > 0);
  const total = $derived(data.facets?.source[data.appealFilters.source]);
  const firstShown = $derived(data.offset + 1);
  const lastShown = $derived(data.offset + rows.length);
</script>

<svelte:window {onkeydown} />

{#if form?.error}
  <ErrorAlert message={form.error} />
{/if}
{#if form?.rescanQueued}
  <p class="m-0 rounded-md border border-blue-500/30 bg-blue-500/10 p-3 text-sm text-blue-200">
    Model #{form.modelId}: the owner edited the text while the appeal was open, so it will be scanned
    again.
  </p>
{/if}

<div class="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
  <aside
    aria-label="Appeal queue"
    class="flex max-h-80 min-h-0 flex-col overflow-hidden rounded-xl border border-dark-4 bg-dark-6 lg:max-h-none lg:w-[35%] lg:max-w-xl lg:min-w-80 lg:shrink-0"
  >
    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if rows.length}
        <AppealQueueList
          {rows}
          selectedId={selected?.appealId ?? null}
          verdicts={acted}
          onselect={select}
        />
      {:else}
        <div class="p-5 text-sm text-dark-0">
          {#if data.q}
            <p class="m-0">Nothing matches "{data.q}".</p>
          {:else if filtersActive}
            <p class="m-0">No open appeals match these filters.</p>
          {:else}
            <p class="m-0">No open appeals against a minor or real-person flag.</p>
          {/if}
          {#if filtersActive || data.q}
            <a href={clearFiltersHref} class="mt-2 inline-block {LINK_CLASS}">Clear filters</a>
          {/if}
        </div>
      {/if}
    </div>

    {#if rows.length}
      <footer
        class="flex shrink-0 flex-wrap items-center gap-3 border-t border-dark-4 px-3 py-2 text-sm text-dark-0"
      >
        <span class="tabular-nums">
          {num(firstShown)}–{num(lastShown)}{total !== undefined ? ` of ${num(total)}` : ''}
        </span>
        {#if acted.size}
          <!-- Later pages are offsets into a queue that has since shrunk, so paging on would skip
               appeals; reloading re-cuts the page from what is still open. -->
          <Button size="sm" variant="outline" onclick={() => invalidateAll()}>
            Refresh queue ({acted.size} decided)
          </Button>
        {:else}
          {#if data.page > 1}<a href={pageHref(data.page - 1)} class={LINK_CLASS}>← Previous</a>{/if}
          {#if data.hasMore}<a href={pageHref(data.page + 1)} class={LINK_CLASS}>Next →</a>{/if}
        {/if}
      </footer>
    {/if}
  </aside>

  <section
    aria-label="Appeal"
    class="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-dark-4 bg-dark-6 lg:overflow-hidden"
  >
    {#if selected}
      {#key selected.appealId}
        <AppealDetail
          row={selected}
          civitaiUrl={data.civitaiUrl}
          verdict={acted.get(selected.appealId)}
          {submit}
          {actionHref}
          bind:upholdForm
          bind:overturnForm
        />
      {/key}
    {:else}
      <div class="grid flex-1 place-items-center p-10 text-center text-base text-dark-2">
        {rows.length ? 'Select an appeal from the queue.' : 'Nothing to review.'}
      </div>
    {/if}
  </section>
</div>
