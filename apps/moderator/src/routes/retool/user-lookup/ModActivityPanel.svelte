<script lang="ts">
  import { browser } from '$app/environment';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { entityUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import ListFilterBar, { type FilterField } from '$lib/components/ListFilterBar.svelte';

  export type ModActivityRow = {
    id: number;
    activity: string;
    entityType: string;
    entityId: number | null;
    createdAt: string;
    moderatorId: number | null;
    moderatorUsername: string | null;
  };

  let { userId, civitaiUrl }: { userId: number; civitaiUrl: string } = $props();

  const COLLAPSED = 5;
  let expanded = $state(false);

  // Same shape as SecuritySignals: derived promise, no state to reassign.
  const activity = $derived(
    browser
      ? fetch(`/api/user-mod-activity/${userId}`).then((r): Promise<ModActivityRow[]> => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
      : null
  );

  const rowUrl = (row: ModActivityRow) => entityUrl(civitaiUrl, row.entityType, row.entityId);

  // Retool's select39 (Action) and select40 (Type), options taken from the rows as Retool's were.
  let filters = $state<Record<string, string>>({});
  const fields = (rows: ModActivityRow[]): FilterField[] => [
    {
      kind: 'select',
      key: 'activity',
      label: 'Action',
      options: [...new Set(rows.map((r) => r.activity))].sort().map((x) => [x, x]),
    },
    {
      kind: 'select',
      key: 'entityType',
      label: 'Type',
      options: [...new Set(rows.map((r) => r.entityType))].sort().map((x) => [x, x]),
    },
  ];
  const filterRows = (rows: ModActivityRow[]) =>
    rows.filter(
      (r) =>
        (!filters.activity || r.activity === filters.activity) &&
        (!filters.entityType || r.entityType === filters.entityType)
    );
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Moderator activity</h3>
  <p class="mb-3 text-xs text-dark-2">
    Actions taken on this account and on content it owns. History begins when ModActivity became
    append-only — anything earlier was collapsed to a single row per action.
  </p>

  {#await activity}
    <p class="text-sm text-dark-2">Loading moderator activity…</p>
  {:then rows}
    {#if !rows}
      <p class="text-sm text-dark-2">Loading moderator activity…</p>
    {:else if rows.length === 0}
      <p class="text-sm text-dark-2">No recorded moderator activity.</p>
    {:else}
      {@const shown = filterRows(rows)}
      <ListFilterBar
        fields={fields(rows)}
        bind:values={filters}
        matched={shown.length}
        total={rows.length}
      />
      <ul class="space-y-1.5 text-sm">
        {#each expanded ? shown : shown.slice(0, COLLAPSED) as row (row.id)}
          {@const url = rowUrl(row)}
          <li class="flex flex-wrap items-baseline gap-x-2">
            <span class="text-dark-2">{dateTime(row.createdAt)}</span>
            <Badge variant="secondary">{row.activity}</Badge>
            {#if url}
              <a href={url} target="_blank" rel="noreferrer" class={LINK_CLASS}>
                {row.entityType} {row.entityId}
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
      {#if rows.length > COLLAPSED}
        <button
          type="button"
          class="mt-3 text-sm {LINK_CLASS}"
          onclick={() => (expanded = !expanded)}
        >
          {expanded ? 'Show less' : `Show all ${rows.length}`}
        </button>
      {/if}
    {/if}
  {:catch}
    <p class="text-sm text-red-300">Could not load moderator activity.</p>
  {/await}
</section>
