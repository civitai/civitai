<script lang="ts">
  import RestrictionTriage from '$lib/components/restrictions/RestrictionTriage.svelte';
  import TriagePageHeader from '$lib/components/triage/TriagePageHeader.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<div class="flex flex-col lg:h-svh">
  <TriagePageHeader
    title="Scam Restrictions"
    subtitle="Accounts flagged for scam activity, and the rulings on them."
    placeholder="Username or user ID"
    searchLabel="Search scam restrictions"
  />
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto border-t border-dark-4">
    <RestrictionTriage {data} {form} fallbackType="scam" />
  </div>
</div>
