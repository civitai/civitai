<script lang="ts">
  import WarningAlert from '$lib/components/WarningAlert.svelte';
  import { num } from '$lib/format';
  import type { TeamOdds } from '$lib/box-flow';
  import { ITEM_DEFINITION_STATUS } from '$lib/mystery-box';
  import ListingPanel from '../ListingPanel.svelte';
  import type { Listing } from '../ListingForm.svelte';

  let {
    boxStatus,
    listings,
    odds,
    dirty,
    boxName,
  }: { boxStatus: string; listings: Listing[]; odds: TeamOdds[]; dirty: boolean; boxName: string } = $props();

  const published = $derived(boxStatus === ITEM_DEFINITION_STATUS.published);
  const averages = $derived(odds.map((entry) => Math.round(entry.avgShelf)));
  const low = $derived(Math.min(...averages));
  const high = $derived(Math.max(...averages));
  const unpriced = $derived(Math.max(...odds.map((entry) => entry.unpriced)));
</script>

<div class="max-w-3xl space-y-4">
  {#if published && listings.length === 0}
    <WarningAlert message="The box is published, but it has no listing yet, so nobody can buy it. Create the listing below; if that fails, the form keeps what you typed and the button turns into Retry." />
  {/if}
  {#if dirty}
    <WarningAlert message="You have unsaved box changes. The listing saves on its own, and the box does not change until you save it on the Publish step." />
  {/if}
  {#if averages.some((value) => value > 0)}
    <p class="text-sm text-dark-2">
      An average draw is worth about <b class="text-white">{num(low)}{high === low ? '' : ` to ${num(high)}`} Buzz</b> at shelf prices. Information to price by, not a promise to buyers.
      {#if unpriced}
        <span class="text-amber-300">{unpriced} {unpriced === 1 ? 'item has' : 'items have'} no shelf price and {unpriced === 1 ? 'is' : 'are'} left out of this average.</span>
      {/if}
    </p>
  {/if}
  <ListingPanel {boxStatus} {listings} defaultTitle={boxName} />
</div>
