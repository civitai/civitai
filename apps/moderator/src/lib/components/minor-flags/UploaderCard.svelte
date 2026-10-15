<script lang="ts">
  import { userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS } from '$lib/format';
  import { pastAppealsText } from '$lib/minor-flags/appeal-row';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';

  let {
    row,
  }: {
    row: {
      userId: number;
      username: string | null;
      otherFlaggedModels: number;
      pastAppeals: { approved: number; rejected: number; void: number; pending: number };
    };
  } = $props();
</script>

<TriageCard title="Uploader">
  <p class="m-0 text-base text-dark-0">
    {#if row.username}
      <a href={userLookupUrl(row.userId)} class="font-medium {LINK_CLASS}">{row.username}</a>
    {:else}
      user #{row.userId}
    {/if}
    · {row.otherFlaggedModels} other flagged model{row.otherFlaggedModels === 1 ? '' : 's'}
    · past appeals: {pastAppealsText(row.pastAppeals)}
  </p>
</TriageCard>
