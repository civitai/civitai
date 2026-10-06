<script lang="ts">
  import * as AlertDialog from '@civitai/ui/components/ui/alert-dialog/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { plural } from '$lib/format';
  import { aboutTime } from '$lib/text-scan-lab/estimate';

  type Request = {
    count: number;
    skipped: number;
    seconds: number;
    stamp: string;
    changed: boolean;
  };

  let {
    request,
    formId = null,
    onconfirm,
    note = null,
    submitting,
    onclose,
  }: {
    request: Request | null;
    formId?: string | null;
    onconfirm?: (stamp: string) => void;
    note?: string | null;
    submitting: boolean;
    onclose: () => void;
  } = $props();

  // Kept through the close animation, which otherwise renders the cleared request's empty values.
  let shown = $state<Request | null>(null);
  $effect.pre(() => {
    if (request) shown = request;
  });
</script>

<AlertDialog.Root
  open={request !== null}
  onOpenChange={(open) => {
    if (!open && !submitting) onclose();
  }}
>
  <AlertDialog.Content>
    {#if shown}
      <AlertDialog.Header>
        <AlertDialog.Title>Run {plural(shown.count, 'case')}?</AlertDialog.Title>
        <AlertDialog.Description>
          {#if shown.changed}
            <span class="mb-2 block text-amber-300">
              The set or the changes moved on since you were asked — check the new numbers.
            </span>
          {/if}
          {aboutTime(shown.seconds)}
          {#if note}{note}{/if}
          {#if shown.skipped}
            {plural(shown.skipped, 'case')} without text will be skipped.
          {/if}
        </AlertDialog.Description>
      </AlertDialog.Header>
      <AlertDialog.Footer>
        <AlertDialog.Cancel disabled={submitting}>Cancel</AlertDialog.Cancel>
        {#if formId}
          <Button type="submit" form={formId} name="confirmed" value={shown.stamp} disabled={submitting}>
            {submitting ? 'Running…' : 'Run'}
          </Button>
        {:else}
          <Button disabled={submitting} onclick={() => shown && onconfirm?.(shown.stamp)}>
            {submitting ? 'Running…' : 'Run'}
          </Button>
        {/if}
      </AlertDialog.Footer>
    {/if}
  </AlertDialog.Content>
</AlertDialog.Root>
