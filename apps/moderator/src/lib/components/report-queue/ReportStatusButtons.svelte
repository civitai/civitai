<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit';
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { REPORT_RULINGS } from '$lib/reports';

  /**
   * A report's ruling, the current status filled. By default the outcomes only (`REPORT_RULINGS`):
   * Pending and Processing are states a report arrives in or was left in, and the row's status badge
   * says which. A queue that still sets them passes `statuses`.
   */
  let {
    reportId,
    status,
    action,
    onSubmit,
    busy = false,
    size = 'sm',
    statuses = REPORT_RULINGS,
  }: {
    reportId: number;
    status: string;
    /** The form action, e.g. `?/setStatus`. It posts `id` and `status`. */
    action: string;
    onSubmit: SubmitFunction;
    busy?: boolean;
    /** `xs` for a collapsed row, where the buttons sit beside the report's one-line summary. */
    size?: 'xs' | 'sm';
    statuses?: readonly string[];
  } = $props();
</script>

<form method="POST" {action} use:enhance={onSubmit} class="flex shrink-0 flex-wrap gap-1.5">
  <input type="hidden" name="id" value={reportId} />
  {#each statuses as s (s)}
    <Button
      type="submit"
      name="status"
      value={s}
      {size}
      variant={s === status ? 'default' : 'outline'}
      disabled={s === status || busy}
    >
      {s}
    </Button>
  {/each}
</form>
