<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { FormState } from '$lib/form-state.svelte';

  /** The server's cap (`saveNotesAction`), so the box stops where the save would refuse. */
  const MAX_REPORT_NOTES = 5000;

  /**
   * One report's internal notes, under the report in `ReportList` — every layout queue's, so a note can
   * go on any report rather than only on the tables and the model queue. Moderators only; the reporter
   * and the reported account never see them.
   *
   * Read-only for a moderator who cannot rule: the note is often the reason a report was left open.
   */
  let {
    reportId,
    notes,
    canEdit,
    action = '?/saveNotes',
  }: {
    reportId: number;
    notes: string | null | undefined;
    canEdit: boolean;
    action?: string;
  } = $props();

  // `reset: false`: the box is filled from the stored notes, and a reset would empty it over a column
  // that still holds text (see `FormState`). A report deleted while the note was typed reloads the
  // list, since the row is gone; every other refusal stays to fix and retry.
  const form = new FormState({
    reload: true,
    reset: false,
    onSuccess: () => toast.success('Notes saved'),
    onSettled: (result) => {
      if (result.type !== 'failure' || !result.data?.gone) return;
      toast.error(String(result.data.error ?? 'That report no longer exists.'));
      invalidateAll();
    },
  });
</script>

{#if canEdit}
  <form method="POST" {action} use:enhance={form.enhance} class="flex flex-col gap-2">
    <input type="hidden" name="id" value={reportId} />
    <Label for="notes-{reportId}" class="text-xs font-medium text-muted-foreground">
      Internal notes
    </Label>
    <Textarea
      id="notes-{reportId}"
      name="internalNotes"
      rows={2}
      maxlength={MAX_REPORT_NOTES}
      value={notes ?? ''}
    />
    <Button type="submit" size="sm" variant="outline" class="self-end" disabled={form.submitting}>
      Save notes
    </Button>
    {#if form.error}<p class="m-0 text-sm text-red-300" role="alert">{form.error}</p>{/if}
  </form>
{:else if notes}
  <div class="flex flex-col gap-1">
    <span class="text-xs font-medium text-muted-foreground">Internal notes</span>
    <p class="m-0 whitespace-pre-wrap wrap-break-word text-sm">{notes}</p>
  </div>
{/if}
