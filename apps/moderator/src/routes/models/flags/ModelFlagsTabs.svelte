<script lang="ts">
  import { page } from '$app/state';
  import TriageTabs from '$lib/components/triage/TriageTabs.svelte';
</script>

<TriageTabs tabs={page.data.modelFlagTabs ?? []} current={page.url.pathname} label="Model Flags" />
