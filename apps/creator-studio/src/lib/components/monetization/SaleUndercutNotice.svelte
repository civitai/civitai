<script lang="ts">
  import * as Alert from '@civitai/ui/components/ui/alert/index.js';
  import { IconAlertTriangle, IconTag } from '@tabler/icons-svelte';
  import type { ModelVersionSaleWindow } from '@civitai/buzz';
  import { resolveSaleUndercut } from '$lib/monetization/sales';

  // A sale sits ON TOP of the base price, so editing the base moves what buyers pay under a sale the
  // creator scheduled days ago and isn't looking at. This says what they'll actually pay, and warns when
  // the new price lands under what the sale is already advertising.
  //
  // A warning, never a refusal: selling deeper than the sale is a legitimate thing to mean.
  let {
    sales,
    storedPrice,
    newPrice,
  }: {
    sales: ModelVersionSaleWindow[] | undefined;
    /** The price on record — what the running sale is discounting today. */
    storedPrice: number;
    /** The price as typed in the editor. */
    newPrice: number | undefined;
  } = $props();

  const undercut = $derived(resolveSaleUndercut({ sales, storedPrice, newPrice }));
</script>

{#if undercut}
  <Alert.Root variant={undercut.undercuts ? 'destructive' : undefined}>
    {#if undercut.undercuts}
      <IconAlertTriangle />
      <Alert.Title>This price is below your scheduled sale</Alert.Title>
      <Alert.Description>
        <p>
          Your {undercut.live ? 'running' : 'scheduled'} sale already brings this version to
          {undercut.currentSalePrice} Buzz. At {undercut.newPrice} Buzz the sale takes it to
          {undercut.newSalePrice} — lower than what the sale is advertising.
        </p>
      </Alert.Description>
    {:else}
      <IconTag />
      <Alert.Title>
        {undercut.live
          ? 'A sale is running on this version'
          : 'A sale is scheduled for this version'}
      </Alert.Title>
      <Alert.Description>
        <p>Buyers will pay {undercut.newSalePrice} Buzz while it runs.</p>
      </Alert.Description>
    {/if}
  </Alert.Root>
{/if}
