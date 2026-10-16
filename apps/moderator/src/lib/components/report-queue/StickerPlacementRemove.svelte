<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { FormState } from '$lib/form-state.svelte';

  /**
   * Remove the sticker placement a `StickerPlacement` report is about (`stickerPlacementActions`), on
   * that report's card in `/reports/image`. A sticker report has always carried which placement it
   * names; until main added the removal (#3766) nothing consumed it, so a moderator read the id out of
   * the details dump and had no way to act on it. Removal is not reversible and settles escrow, so it
   * confirms.
   *
   * No reload: the card says it is done, and reloading the grid would clear every other card's
   * selection and verdict on the page.
   */
  let { placementId }: { placementId: number } = $props();

  let confirming = $state(false);
  let removed = $state(false);
  const form = new FormState({
    reset: false,
    onSuccess: () => {
      confirming = false;
      removed = true;
    },
  });
</script>

<div class="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
  {#if removed}
    <p class="m-0">Sticker placement <code>#{placementId}</code> removed.</p>
  {:else}
    <p class="m-0 mb-2">
      About sticker placement <code>#{placementId}</code>. Removing it takes the sticker off the image
      for everyone.
    </p>
    {#if confirming}
      <form method="POST" action="?/removePlacement" use:enhance={form.enhance} class="flex flex-wrap gap-2">
        <input type="hidden" name="placementId" value={placementId} />
        <Button type="submit" size="xs" variant="destructive" disabled={form.submitting}>
          Yes, remove it
        </Button>
        <Button type="button" size="xs" variant="outline" onclick={() => (confirming = false)}>
          Cancel
        </Button>
      </form>
    {:else}
      <Button size="xs" variant="destructive" onclick={() => (confirming = true)}>Remove placement</Button>
    {/if}
    {#if form.error}<p class="m-0 mt-2 text-red-300" role="alert">{form.error}</p>{/if}
  {/if}
</div>
