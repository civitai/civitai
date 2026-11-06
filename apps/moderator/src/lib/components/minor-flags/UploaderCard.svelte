<script lang="ts">
  import { plural } from '$lib/format';
  import { yearMonth } from '$lib/minor-flags/appeal-row';
  import { flagsText, type ModelFlagDetail } from '$lib/minor-flags/model-detail';
  import FactRow from '$lib/components/minor-flags/FactRow.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';

  let {
    row,
    detail,
    otherLabel = 'other flagged model',
    otherLabelMany,
  }: {
    row: { userId: number; username: string | null; otherFlaggedModels: number };
    detail: Promise<ModelFlagDetail>;
    /** What the count of `otherFlaggedModels` counts, when it is not flags. */
    otherLabel?: string;
    /** Plural of `otherLabel` when appending an s is wrong ("match"). */
    otherLabelMany?: string;
  } = $props();
</script>

{#snippet loaded(text: (d: ModelFlagDetail) => string)}
  {#await detail}<span class="text-dark-2">…</span>{:then d}{text(d)}{:catch}<span
      class="text-dark-2">could not load</span
    >{/await}
{/snippet}

<TriageCard dense title="Uploader">
  <dl class="m-0 space-y-2">
    <FactRow label="User">
      {#if row.username}
        <span class="font-medium text-white">{row.username}</span>
      {:else}
        user #{row.userId}
      {/if}
      {@render loaded((d) => (d.uploaderJoinedAt ? ` · joined ${yearMonth(d.uploaderJoinedAt)}` : ''))}
    </FactRow>
    <FactRow label="Models">
      {@render loaded(
        (d) => `${d.uploaderPublished} published, ${d.uploaderModUnpublished} unpublished by mods`
      )}
      · {plural(row.otherFlaggedModels, otherLabel, otherLabelMany)}
    </FactRow>
    <FactRow label="Flags">{@render loaded((d) => flagsText(d.flagsReverted, d.strikes))}</FactRow>
    <FactRow label="Notes">
      {@render loaded((d) =>
        d.notes === null ? 'unavailable' : d.notes ? plural(d.notes, 'note') : 'none'
      )}
    </FactRow>
  </dl>
</TriageCard>
