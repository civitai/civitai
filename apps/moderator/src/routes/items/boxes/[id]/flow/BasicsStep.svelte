<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import type { BoxDraft } from '$lib/mystery-box';
  import DetailsPanel from '../DetailsPanel.svelte';

  let {
    draft = $bindable(),
    events,
    teams,
    filling,
    fillError,
    onfill,
  }: {
    draft: BoxDraft;
    events: { event: string; teams: string[] }[];
    teams: string[];
    filling: boolean;
    fillError: string | null;
    onfill: () => void;
  } = $props();
</script>

<div class="max-w-3xl space-y-4">
  <DetailsPanel bind:draft {events} {teams} />
  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h2 class="mb-1 text-base font-semibold text-white">Fastest way to start</h2>
    <p class="mb-3 text-xs text-dark-2">
      {#if draft.event}
        Puts every {draft.event} design that has a shelf price into three tiers by shelf price. You can still change anything on the next step, and nothing is saved until you press Save.
      {:else}
        Pick the event above, then fill the box from it: one tap puts every design into tiers by shelf price.
      {/if}
    </p>
    <Button disabled={!draft.event || filling} onclick={onfill}>Fill from the event, tiers by shelf price</Button>
    {#if fillError}<ErrorAlert class="mt-3" message={fillError} />{/if}
  </section>
</div>
