<script lang="ts">
  import { page } from '$app/state';
  import { modelFlagTabs } from './model-flag-tabs';
  import TriageTabs from '$lib/components/triage/TriageTabs.svelte';

  // Top of each tab's queue column, not a row across the page: the open item needs that height on a
  // 1080p screen.
  const tabs = $derived(modelFlagTabs());
</script>

<TriageTabs compact {tabs} current={page.url.pathname} label="Model Flags" />
