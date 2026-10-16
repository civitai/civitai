<script lang="ts">
  import {
    GENERATOR_RESTRICTION_TYPES,
    RESTRICTION_TYPE,
    RESTRICTION_TYPE_LABELS,
    RULINGS_WIRED_FOR,
  } from '$lib/restriction-types';
  import RestrictionTriage from '$lib/components/restrictions/RestrictionTriage.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<div class="flex flex-col gap-3 px-6 pb-4 lg:h-[calc(100svh-3rem)]">
  <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
    <h1 class="m-0 text-xl font-semibold text-white">
      {data.type === RESTRICTION_TYPE ? 'Generator' : RESTRICTION_TYPE_LABELS[data.type]} Restrictions
    </h1>
    {#if data.type === RESTRICTION_TYPE}
      <p class="m-0 text-sm text-dark-2">
        Raised by the prompt-auditing system, and the rulings on them.
      </p>
    {:else if !RULINGS_WIRED_FOR.includes(data.type)}
      <!-- Named rather than described: no verdict effects exist for this type, so the resolve and ban
           actions refuse these rows server-side. Saying so here is what stops a moderator reading that
           refusal as a bug. -->
      <p class="m-0 text-sm text-dark-2">
        Review only — rulings are not yet wired for this type.
      </p>
    {/if}
  </div>

  <RestrictionTriage
    {data}
    {form}
    types={GENERATOR_RESTRICTION_TYPES}
    fallbackType={RESTRICTION_TYPE}
  />
</div>
