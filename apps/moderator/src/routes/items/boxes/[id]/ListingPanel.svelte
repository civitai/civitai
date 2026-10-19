<script lang="ts">
  import { ITEM_DEFINITION_STATUS } from '$lib/mystery-box';
  import ListingForm, { type Listing } from './ListingForm.svelte';

  let {
    boxStatus,
    listings,
    defaultTitle = '',
  }: { boxStatus: string; listings: Listing[]; defaultTitle?: string } = $props();
</script>

<section class="mb-6 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-1 text-base font-semibold text-white">Sell it</h2>
  <p class="mb-3 text-xs text-dark-2">
    A box is sold through its own card on the event page, never the shop: its listing is always
    unlisted and in no section. Paid Buzz only. Times are UTC.
    {#if boxStatus !== ITEM_DEFINITION_STATUS.published}
      <span class="text-amber-300">Nothing sells until the box is published.</span>
    {/if}
  </p>

  <div class="space-y-4">
    {#each listings as listing (listing.id)}
      <ListingForm {listing} />
    {/each}
    <ListingForm listing={null} {defaultTitle} />
  </div>
</section>
