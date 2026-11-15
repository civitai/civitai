<script lang="ts">
  import { enhance } from '$app/forms';
  import * as AlertDialog from '@civitai/ui/components/ui/alert-dialog/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import type { ShopItemRow } from '$lib/server/knights/shop-catalog.service';
  import { impactOfChange } from './impact';
  import { restoreNote, type StatusTarget } from './shop-view';

  let {
    target = $bindable(null),
    items,
    day,
    onsettled,
  }: {
    target?: StatusTarget | null;
    items: readonly ShopItemRow[];
    day: string;
    /** After the write lands, so the page can close a sheet showing the same item. */
    onsettled: () => void;
  } = $props();

  let last: StatusTarget | null = null;
  const shown = $derived.by(() => {
    if (target) last = target;
    return last;
  });
  const retiring = $derived(shown?.action === 'retire');
  const impact = $derived(
    shown ? impactOfChange([...items], day, shown.item.id, { active: !retiring }) : []
  );

  const form = new FormState({
    reload: true,
    onSuccess: () => {
      toast.success(retiring ? 'Retired' : 'Restored');
      target = null;
      onsettled();
    },
  });
</script>

<AlertDialog.Root
  bind:open={() => target !== null, (open) => !open && (target = null)}
  onOpenChangeComplete={(open) => !open && (form.error = null)}
>
  <AlertDialog.Content>
    {#if shown}
      <form method="POST" action={retiring ? '?/retire' : '?/restore'} use:enhance={form.enhance}>
        <input type="hidden" name="id" value={shown.item.id} />
        <AlertDialog.Header>
          <AlertDialog.Title>{retiring ? 'Retire' : 'Restore'} {shown.item.name}?</AlertDialog.Title>
          <AlertDialog.Description>
            {#if retiring}
              It leaves the shop on the next request. Purchases already made keep their record; it
              stays listed here and can be restored.
            {:else}
              {restoreNote(shown.item) ?? 'It goes back on sale on the next request, at its current price.'}
            {/if}
          </AlertDialog.Description>
        </AlertDialog.Header>
        {#each impact as line (line)}
          <p class="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-sm text-amber-200">
            {line}
          </p>
        {/each}
        {#if form.error}<ErrorAlert class="mt-3" message={form.error} />{/if}
        <AlertDialog.Footer class="mt-4">
          <AlertDialog.Cancel type="button">Cancel</AlertDialog.Cancel>
          <Button
            type="submit"
            variant={retiring ? 'destructive' : 'default'}
            disabled={form.submitting}
          >
            {retiring ? 'Retire' : 'Restore'}
          </Button>
        </AlertDialog.Footer>
      </form>
    {/if}
  </AlertDialog.Content>
</AlertDialog.Root>
