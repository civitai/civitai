<script lang="ts">
  import { untrack } from 'svelte';
  import { browser } from '$app/environment';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { entityUrl } from '$lib/entity-url';
  import { fetchJson } from '$lib/fetch-json';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import type { ModActivityCount, ModActivityCursor } from '$lib/mod-activity';
  import type { ModActivityRow, RetoolActivityRow } from '$lib/server/user-account.service';
  import ListFilterBar, { type FilterField } from '$lib/components/ListFilterBar.svelte';

  type Row = Omit<ModActivityRow, 'createdAt'> & { createdAt: string };

  let { userId, civitaiUrl }: { userId: number; civitaiUrl: string } = $props();
  const uid = $props.id();

  let includeRatings = $state(false);
  let filters = $state<Record<string, string>>({});

  const url = (params: Record<string, string | number | undefined>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
      if (value !== undefined && value !== '') search.set(key, String(value));
    return `/api/user-mod-activity/${userId}?${search}`;
  };
  const ratings = $derived(includeRatings ? 1 : undefined);

  // Each request is keyed on only what it depends on: the Retool era on nothing, the filter summary on
  // the ratings toggle (about a second on the largest accounts), and the page on everything.
  const retool = $derived(
    browser ? fetchJson<RetoolActivityRow[]>(url({ view: 'retool' })) : null
  );
  const summary = $derived(
    browser ? fetchJson<ModActivityCount[]>(url({ view: 'summary', ratings })) : null
  );

  const query = $derived(
    url({ ratings, activity: filters.activity, type: filters.entityType })
  );

  // The cursors walked so far, so Previous is an index move. Tagged with the query that produced them,
  // so a filter change never hands one list another's cursor, and reset when the query changes so
  // returning to a filter starts it from the top rather than from a page left earlier.
  const START = { query: '', cursors: [null], index: 0 };
  let walk = $state<{ query: string; cursors: (ModActivityCursor | null)[]; index: number }>(START);
  $effect(() => {
    query;
    untrack(() => (walk = START));
  });
  const position = $derived(walk.query === query ? walk : { ...START, query });
  const cursor = $derived(position.cursors[position.index]);

  const page = $derived(
    browser
      ? fetchJson<{ rows: Row[]; next: ModActivityCursor | null }>(
          cursor ? `${query}&before=${encodeURIComponent(cursor.at)}&beforeId=${cursor.id}` : query
        )
      : null
  );

  const advance = (next: ModActivityCursor) => {
    walk = {
      query,
      cursors: [...position.cursors.slice(0, position.index + 1), next],
      index: position.index + 1,
    };
  };
  const back = () => {
    walk = { ...position, index: Math.max(0, position.index - 1) };
  };

  // Ratings-only actions leave the options when ratings are hidden, and a filter on one would keep
  // narrowing the list while its control reads as unset.
  const setIncludeRatings = (value: boolean) => {
    includeRatings = value;
    filters = {};
  };

  const rowUrl = (row: Row) => entityUrl(civitaiUrl, row.entityType, row.entityId);

  const tally = (counts: ModActivityCount[], key: 'activity' | 'entityType'): [string, string][] => {
    const totals = new Map<string, number>();
    for (const c of counts) totals.set(c[key], (totals.get(c[key]) ?? 0) + c.count);
    return [...totals]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, count]) => [value, `${value} (${num(count)})`]);
  };
  const fields = (counts: ModActivityCount[]): FilterField[] => [
    { kind: 'select', key: 'activity', label: 'Action', options: tally(counts, 'activity') },
    { kind: 'select', key: 'entityType', label: 'Type', options: tally(counts, 'entityType') },
  ];
  const countMatching = (counts: ModActivityCount[], filtered: boolean) =>
    counts
      .filter(
        (c) =>
          !filtered ||
          ((!filters.activity || c.activity === filters.activity) &&
            (!filters.entityType || c.entityType === filters.entityType))
      )
      .reduce((sum, c) => sum + c.count, 0);
  const filtered = $derived(!!(filters.activity || filters.entityType));
</script>

{#snippet pager(next: ModActivityCursor | null)}
  {#if position.index > 0 || next}
    <div class="mt-3 flex items-center gap-2">
      <Button size="xs" variant="outline" disabled={position.index === 0} onclick={back}>
        Previous
      </Button>
      <span class="text-xs text-dark-2">Page {num(position.index + 1)}</span>
      <Button size="xs" variant="outline" disabled={!next} onclick={() => next && advance(next)}>
        Next
      </Button>
    </div>
  {/if}
{/snippet}

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Moderator activity</h3>
  <p class="mb-3 text-xs text-dark-2">
    Actions taken on this account and on content it owns. History begins when ModActivity became
    append-only — anything earlier was collapsed to a single row per action. Knights of New Order
    rating votes and tag edits are hidden unless included below.
  </p>

  <div class="mb-3 flex flex-wrap items-end gap-x-4 gap-y-2">
    {#await summary}
      <p class="pb-1.5 text-xs text-dark-2">Loading filters…</p>
    {:then counts}
      {#if counts}
        <ListFilterBar
          fields={fields(counts)}
          bind:values={filters}
          matched={countMatching(counts, true)}
          total={countMatching(counts, false)}
        />
      {:else}
        <p class="pb-1.5 text-xs text-dark-2">Loading filters…</p>
      {/if}
    {:catch e}
      <p class="pb-1.5 text-xs text-red-300">Could not load the filter options: {e.message}</p>
      {#if filtered}
        <Button size="sm" variant="outline" onclick={() => (filters = {})}>Clear filters</Button>
      {/if}
    {/await}
    <div class="flex items-center gap-2 pb-1.5">
      <Checkbox
        id="{uid}-ratings"
        bind:checked={() => includeRatings, setIncludeRatings}
      />
      <Label for="{uid}-ratings" class="text-xs font-normal text-dark-0">
        Include ratings and tag edits
      </Label>
    </div>
  </div>

  {#await page}
    <p class="text-sm text-dark-2">Loading moderator activity…</p>
  {:then p}
    {#if !p}
      <p class="text-sm text-dark-2">Loading moderator activity…</p>
    {:else if p.rows.length === 0}
      <p class="text-sm text-dark-2">
        {position.index > 0
          ? 'No more activity.'
          : filtered
            ? 'No activity matches these filters.'
            : includeRatings
              ? 'Nothing in ModActivity for this account.'
              : 'No moderator actions on this account (ratings and tag edits are hidden).'}
      </p>
    {:else}
      <ul class="space-y-1.5 text-sm">
        {#each p.rows as row (row.id)}
          {@const link = rowUrl(row)}
          <li class="flex flex-wrap items-baseline gap-x-2">
            <span class="text-dark-2">{dateTime(row.createdAt)}</span>
            <Badge variant="secondary">{row.activity}</Badge>
            {#if link}
              <a href={link} target="_blank" rel="noreferrer" class={LINK_CLASS}>
                {row.entityType}
                {row.entityId}
              </a>
            {:else}
              <span class="text-dark-0">{row.entityType}</span>
            {/if}
            <span class="text-xs text-dark-2">
              by {row.moderatorUsername ?? (row.moderatorId ? `#${row.moderatorId}` : 'system')}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
    {@render pager(p?.next ?? null)}
  {:catch e}
    <p class="text-sm text-red-300">Could not load moderator activity: {e.message}</p>
    {@render pager(null)}
  {/await}

  <!-- Pre-migration history from `ReToolActions`, kept in its own list: these rows have no entity link
       and no moderator id (`User` is a Retool display name), so interleaving them would imply a
       continuity the data does not have. Rows are matched by the account id appearing in the
       free-text action, which is why the phrasing varies. -->
  {#await retool then rows}
    {#if rows?.length}
      <div class="mt-5 border-t border-dark-4 pt-4">
        <h4 class="mb-1 text-xs tracking-wide text-dark-2 uppercase">
          Retool era ({rows.length})
        </h4>
        <p class="mb-2 text-xs text-dark-2">
          Before the migration. Matched on the account id inside the logged action, so the wording is
          whatever the Retool app wrote; the moderator is a Retool display name, not an account.
        </p>
        <ul class="space-y-1.5 text-sm">
          {#each rows as row (row.id)}
            <li class="flex flex-wrap items-baseline gap-x-2">
              <span class="text-dark-2">{dateTime(row.at)}</span>
              <span class="text-dark-0">{row.action}</span>
              <span class="text-xs text-dark-2">by {row.moderator ?? 'unknown'}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  {:catch e}
    <p class="mt-5 text-xs text-red-300">Could not load the Retool-era history: {e.message}</p>
  {/await}
</section>
