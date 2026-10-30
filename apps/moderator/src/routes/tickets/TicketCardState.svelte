<script lang="ts">
  import { userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS } from '$lib/format';

  let {
    card,
    unlinked,
    unavailable,
    lookup = 'basic',
  }: {
    card: { status: 'unlinked' } | { status: 'unavailable'; userId: number };
    /** What a ticket with no linked user cannot show, after "No linked Civitai account — ". */
    unlinked: string;
    /** The sentence for a card whose read failed, e.g. "Payouts unavailable." */
    unavailable: string;
    /** The User Lookup section the failed card links to. */
    lookup?: string;
  } = $props();
</script>

{#if card.status === 'unlinked'}
  <p class="m-0 text-dark-2">No linked Civitai account — {unlinked}</p>
{:else}
  <p class="m-0 text-amber-300">
    {unavailable}
    <a class={LINK_CLASS} href={userLookupUrl(card.userId, lookup)}>User #{card.userId}</a>
  </p>
{/if}
