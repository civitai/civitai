<script lang="ts">
  import type { Snippet } from 'svelte';
  import TriagePageHeader from '$lib/components/triage/TriagePageHeader.svelte';

  let { children }: { children: Snippet } = $props();
</script>

<div class="flex flex-col lg:h-svh">
  <TriagePageHeader
    title="Model Flags"
    subtitle="Minor and real-person flags on models. Tab = whether a flag is applied; chip = what found it."
    placeholder="Model name, id or uploader"
    searchLabel="Search model flags"
  />

  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto border-t border-dark-4">
    {@render children()}
  </div>
</div>
