<script lang="ts">
  import {
    GENERATOR_RESTRICTION_TYPES,
    RESTRICTION_TYPE,
    RULINGS_WIRED_FOR,
  } from '$lib/restriction-types';
  import RestrictionTriage from '$lib/components/restrictions/RestrictionTriage.svelte';
  import RestrictionTypeTabs from '$lib/components/restrictions/RestrictionTypeTabs.svelte';
  import TriagePageHeader from '$lib/components/triage/TriagePageHeader.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // Named rather than described: no verdict effects exist for some types, so the resolve and ban
  // actions refuse their rows server-side. Saying so here stops a moderator reading that refusal as a bug.
  const subtitle = $derived(
    RULINGS_WIRED_FOR.includes(data.type)
      ? 'Raised by the prompt-auditing system, and the rulings on them.'
      : 'Review only — rulings are not yet wired for this type.'
  );
</script>

<div class="flex flex-col lg:h-svh">
  <TriagePageHeader
    title="Generator restrictions"
    {subtitle}
    placeholder="Username or user ID"
    searchLabel="Search restrictions"
  />
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto border-t border-dark-4">
    <RestrictionTriage {data} {form} fallbackType={RESTRICTION_TYPE}>
      {#snippet tabs()}
        {#if GENERATOR_RESTRICTION_TYPES.length > 1}
          <RestrictionTypeTabs
            compact
            types={GENERATOR_RESTRICTION_TYPES}
            current={data.type}
            fallbackType={RESTRICTION_TYPE}
            counts={data.facets?.type}
          />
        {/if}
      {/snippet}
    </RestrictionTriage>
  </div>
</div>
