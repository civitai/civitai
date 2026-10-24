<script lang="ts">
  import TriagePageHeader from '$lib/components/triage/TriagePageHeader.svelte';
  import RuleMatchTriage from './RuleMatchTriage.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<div class="flex flex-col lg:h-svh">
  <TriagePageHeader
    title="Model rule matches"
    subtitle="Models whose text matched a model rule. In Review the model stays live until you confirm; in Auto it was taken down when it matched."
    placeholder="Model ID, username or user ID"
    searchLabel="Search matches"
  />
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
    <RuleMatchTriage {data} {form} canStrike={data.grants['user.strike'] === true} />
  </div>
</div>
