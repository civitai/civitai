<script lang="ts">
  import { LINK_CLASS } from '$lib/format';
  import type { SetRunTotals } from '$lib/server/text-scan-lab/publish';
  import { NOTHING_SCORED, scoreChips } from '$lib/text-scan-lab/labels';

  let {
    rows,
    draftUpdatedAt,
    draftLabel = 'draft',
  }: {
    rows: SetRunTotals[];
    draftUpdatedAt: Date | null;
    draftLabel?: string;
  } = $props();

  const chips = (run: SetRunTotals['active']) =>
    run ? scoreChips(run.totals).join(' · ') || NOTHING_SCORED : 'not run';
</script>

<div class="text-xs text-dark-2">
  {#if rows.length}
    <p class="mb-1">Latest finished test-set runs — for reference; they never block publishing.</p>
    {#each rows as row (row.setId)}
      {@const stale =
        row.draft?.draftUpdatedAt &&
        draftUpdatedAt &&
        row.draft.draftUpdatedAt.getTime() !== draftUpdatedAt.getTime()}
      <p>
        <a
          href="/text-scan/test-sets/{row.setId}{row.draft && row.active
            ? `?a=${row.active.runId}&b=${row.draft.runId}`
            : ''}"
          class={LINK_CLASS}>{row.setName}</a
        >
        — {draftLabel}: <span class="text-dark-0">{chips(row.draft)}</span>{stale
          ? ' (edited since)'
          : ''}
        · current: <span class="text-dark-0">{chips(row.active)}</span>
      </p>
    {/each}
  {:else}
    <p>No test-set runs yet.</p>
  {/if}
</div>
