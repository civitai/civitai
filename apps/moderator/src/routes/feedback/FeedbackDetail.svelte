<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { dateTime } from '$lib/format';
  import { FEEDBACK_STATUSES, type FeedbackContext } from '$lib/feedback';
  import FeedbackContextPanel from './FeedbackContextPanel.svelte';
  import FeedbackPromote from './FeedbackPromote.svelte';
  import type { FeedbackRow, FeedbackSibling } from '$lib/server/feedback.service';

  let {
    row,
    context,
    siblings,
    grafanaUrl,
    civitaiUrl,
    canTriage,
    canPromote,
  }: {
    row: FeedbackRow;
    context: FeedbackContext;
    siblings: FeedbackSibling[];
    grafanaUrl: string | null;
    civitaiUrl: string;
    canTriage: boolean;
    canPromote: boolean;
  } = $props();

  /**
   * 🔴 `reset: false`. The note box is pre-filled from the COLUMN, and a reset blanks it without
   * repopulating — the bound expression is unchanged by a status-only save, so Svelte does not
   * rewrite it. The operator's next status click would then post an empty note and destroy the
   * stored one, with a green screen over it.
   */
  const triageForm = new FormState({ onSuccess: null, reload: true, reset: false });
</script>

<div class="flex flex-col gap-6 p-5 text-left">
  <p class="wrap-break-word text-sm whitespace-pre-wrap">{row.message}</p>

  <FeedbackContextPanel {context} createdAt={row.createdAt} {civitaiUrl} {grafanaUrl} />

  <section class="flex flex-col gap-3">
    <h3 class="text-xs tracking-wide text-dark-2 uppercase">Triage</h3>

    {#if canTriage}
      <form method="POST" action="?/triage" use:enhance={triageForm.enhance} class="flex flex-col gap-3">
        <input type="hidden" name="id" value={row.id} />
        <!-- 🔴 The status the operator is LOOKING AT rides along, and the UPDATE is scoped on it.
             Without it a second moderator's verdict silently overwrites the first. -->
        <input type="hidden" name="expectedStatus" value={row.status} />

        <div class="flex flex-col gap-1">
          <Label for={`note-${row.id}`} class="text-xs text-dark-2">
            Internal note — never seeded into an issue
          </Label>
          <!-- Every status click rewrites this column, so the box must always carry the stored note. -->
          <Textarea id={`note-${row.id}`} name="note" rows={2} value={row.triageNote ?? ''} />
        </div>

        <div class="flex flex-wrap gap-2">
          {#each FEEDBACK_STATUSES as status (status)}
            <Button
              type="submit"
              name="status"
              value={status}
              size="sm"
              variant={status === row.status ? 'default' : 'outline'}
              disabled={triageForm.submitting}
            >
              {status === row.status ? `Save (${status})` : status}
            </Button>
          {/each}
        </div>
      </form>
    {:else}
      <p class="text-sm text-dark-2">
        You can read this queue but not triage it — that needs the “Set feedback status and triage
        notes” permission.
      </p>
    {/if}

    <!-- 🔴 OUTSIDE the `canTriage` arm, for the same reason as `FeedbackPromote`'s: `reload: true`
         re-runs `load` BEFORE the message is assigned, so a 403 raised by a grant revoked mid-session
         flips this to the permission paragraph and unmounts an alert nested in the form's arm. -->
    {#if triageForm.error}
      <ErrorAlert message={triageForm.error} />
    {/if}

    {#if row.handledAt}
      <p class="text-xs text-dark-2">
        Handled by {row.handledByUsername ?? `#${row.handledById}`} on {dateTime(row.handledAt)}
      </p>
    {/if}
  </section>

  <FeedbackPromote {row} {siblings} {civitaiUrl} {canPromote} />
</div>
