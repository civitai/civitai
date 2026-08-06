<script lang="ts">
  import { browser } from '$app/environment';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime } from './format';

  export type ModActivityRow = {
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

  const ENTITY_PATH: Record<string, string> = {
    image: 'images',
    model: 'models',
    article: 'articles',
  };

  const entityUrl = (row: ModActivityRow) =>
    row.entityId && ENTITY_PATH[row.entityType]
      ? `${civitaiUrl}/${ENTITY_PATH[row.entityType]}/${row.entityId}`
      : null;
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
    {#if !rows || rows.length === 0}
      <p class="text-sm text-dark-2">No recorded moderator activity.</p>
    {:else}
      <ul class="space-y-1.5 text-sm">
        {#each expanded ? rows : rows.slice(0, COLLAPSED) as row (row.createdAt + row.activity + row.entityId)}
          {@const url = entityUrl(row)}
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
