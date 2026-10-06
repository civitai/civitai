<script lang="ts" generics="Q extends { stamp: string; cost: number | null; changed: boolean }">
  import type { Snippet } from 'svelte';
  import * as AlertDialog from '@civitai/ui/components/ui/alert-dialog/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { num } from '$lib/format';

  let {
    quote,
    formId,
    title,
    submitting,
    onclose,
    children,
  }: {
    quote: Q | null;
    formId: string;
    title: (quote: Q) => string;
    submitting: boolean;
    onclose: () => void;
    children: Snippet<[Q]>;
  } = $props();

  // Kept through the close animation, which otherwise renders the cleared quote's empty values.
  let last: Q | null = null;
  const shown = $derived(quote ? (last = quote) : last);
</script>

<AlertDialog.Root
  open={quote !== null}
  onOpenChange={(open) => {
    if (!open && !submitting) onclose();
  }}
>
  <AlertDialog.Content>
    {#if shown}
      <AlertDialog.Header>
        <AlertDialog.Title>{title(shown)}</AlertDialog.Title>
        <AlertDialog.Description>
          {#if shown.changed}
            <span class="mb-2 block text-amber-300">
              What would run changed since the last quote — check the new numbers.
            </span>
          {/if}
          {@render children(shown)}
          Quoted at {shown.cost == null ? 'an unknown cost' : `≈ ${num(Math.ceil(shown.cost))} Buzz`}.
        </AlertDialog.Description>
      </AlertDialog.Header>
      <AlertDialog.Footer>
        <AlertDialog.Cancel disabled={submitting}>Cancel</AlertDialog.Cancel>
        <Button type="submit" form={formId} name="confirmed" value={shown.stamp} disabled={submitting}>
          {submitting ? 'Running…' : 'Run'}
        </Button>
      </AlertDialog.Footer>
    {/if}
  </AlertDialog.Content>
</AlertDialog.Root>
