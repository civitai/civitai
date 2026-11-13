<script lang="ts">
  import AppealImages from '$lib/components/minor-flags/AppealImages.svelte';
  import FactRow from '$lib/components/minor-flags/FactRow.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { plainText } from '$lib/format';
  import type { HoldProfile } from './hold-context';

  let { profile, blurred }: { profile: HoldProfile; blurred: boolean } = $props();

  // Rendered as text, never as markup: bios are user-written HTML.
  const facts = $derived(
    (
      [
        ['Bio', profile.bio],
        ['Bio (SFW)', profile.sfwBio],
        ['Message', profile.message],
        ['Message (SFW)', profile.sfwMessage],
        ['Location', profile.location],
      ] as [string, string | null][]
    )
      .map(([label, value]) => [label, plainText(value)] as const)
      .filter(([, value]) => value)
  );
</script>

<TriageCard dense title="Profile">
  <AppealImages
    images={profile.images}
    {blurred}
    emptyText="This profile has no avatar or cover image."
  />
  {#if facts.length}
    <dl class="m-0 mt-3 space-y-1.5">
      {#each facts as [label, value] (label)}
        <FactRow {label}><span class="break-words whitespace-pre-wrap">{value}</span></FactRow>
      {/each}
    </dl>
  {/if}
</TriageCard>
