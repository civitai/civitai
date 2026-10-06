<script lang="ts">
  import type { Snippet } from 'svelte';
  import * as AlertDialog from '@civitai/ui/components/ui/alert-dialog/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { num } from '$lib/format';

  /**
   * Confirms a quoted, billed batch. Confirming submits `formId` with the quote's stamp as
   * `confirmed`; the server runs only if what it would run still matches that stamp.
   */
  let {
    quote,
    formId,
    title,
    submitting,
    onclose,
    children,
  }: {
    quote: { stamp: string; cost: number | null; changed: boolean } | null;
    formId: string;
    title: string;
    submitting: boolean;
    onclose: () => void;
    /** What will be scanned, before the cost. */
    children: Snippet;
  } = $props();
</script>

<AlertDialog.Root
  open={quote !== null}
  onOpenChange={(open) => {
    if (!open && !submitting) onclose();
  }}
>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>{title}</AlertDialog.Title>
      <AlertDialog.Description>
        {#if quote?.changed}
          <span class="mb-2 block text-amber-300">
            What would run changed since the last quote — check the new numbers.
          </span>
        {/if}
        {@render children()}
        Quoted at {quote?.cost == null ? 'an unknown cost' : `≈ ${num(Math.ceil(quote.cost))} Buzz`}.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={submitting}>Cancel</AlertDialog.Cancel>
      <Button type="submit" form={formId} name="confirmed" value={quote?.stamp} disabled={submitting}>
        {submitting ? 'Running…' : 'Run'}
      </Button>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
