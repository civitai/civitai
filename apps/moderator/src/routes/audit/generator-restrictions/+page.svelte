<script lang="ts">
  import {
    GENERATOR_RESTRICTION_TYPES,
    RESTRICTION_TYPE,
    RESTRICTION_TYPE_LABELS,
    RULINGS_WIRED_FOR,
  } from '$lib/restriction-types';
  import RestrictionQueue from '$lib/components/restrictions/RestrictionQueue.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<header class="page-header">
  <h1>
    {data.type === RESTRICTION_TYPE ? 'Generator' : RESTRICTION_TYPE_LABELS[data.type]} Restrictions
  </h1>
  {#if data.type === RESTRICTION_TYPE}
    <p>Generation restrictions raised by the prompt-auditing system, and the rulings on them.</p>
  {:else if RULINGS_WIRED_FOR.includes(data.type)}
    <p>{RESTRICTION_TYPE_LABELS[data.type]} restrictions, and the rulings on them.</p>
  {:else}
    <!-- Named rather than described: no verdict effects exist for this type, so the resolve and ban
         actions refuse these rows server-side. Saying so here is what stops a moderator reading that
         refusal as a bug. -->
    <p>
      {RESTRICTION_TYPE_LABELS[data.type]} restrictions. Review only — rulings are not yet wired for this
      type.
    </p>
  {/if}
</header>

<RestrictionQueue
  {data}
  types={GENERATOR_RESTRICTION_TYPES}
  fallbackType={RESTRICTION_TYPE}
/>
