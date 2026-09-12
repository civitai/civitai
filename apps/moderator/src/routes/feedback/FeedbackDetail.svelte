<script lang="ts">
  import { enhance } from '$app/forms';
  import { page } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, dateTime, shortAge } from '$lib/format';
  import { urlWith } from '$lib/url';
  import { FEEDBACK_STATUSES, type FeedbackContext } from '$lib/feedback';
  import FeedbackContextPanel from './FeedbackContext.svelte';
  import type { FeedbackRow } from '$lib/server/feedback.service';

  type Sibling = { id: number; area: string; message: string; createdAt: Date; status: string };

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
    siblings: Sibling[];
    grafanaUrl: string | null;
    civitaiUrl: string;
    canTriage: boolean;
    canPromote: boolean;
  } = $props();

  // `reload` on both: the panel renders the row's own stored state, so a write that does not re-run
  // `load` leaves the operator looking at what they replaced.
  const triageForm = new FormState({ onSuccess: null, reload: true });
  const promoteForm = new FormState({ onSuccess: null, reload: true });

  // Which half of the promote form is armed. Not a URL concern — it is a local choice, and opening
  // another row unmounts this component along with it.
  let attachMode = $state(false);
</script>

<div class="flex flex-col gap-6 p-5 text-left">
  <p class="wrap-break-word text-sm whitespace-pre-wrap">{row.message}</p>

  <FeedbackContextPanel {context} createdAt={row.createdAt} {civitaiUrl} {grafanaUrl} />

  <section class="flex flex-col gap-3">
    <h3 class="text-xs font-semibold tracking-wide text-dark-2 uppercase">Triage</h3>

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
      {#if triageForm.error}
        <ErrorAlert message={triageForm.error} />
      {/if}
    {:else}
      <p class="text-sm text-dark-2">
        You can read this queue but not triage it — that needs the “Set feedback status and triage
        notes” permission.
      </p>
    {/if}

    {#if row.handledAt}
      <p class="text-xs text-dark-2">
        Handled by {row.handledByUsername ?? `#${row.handledById}`} on {dateTime(row.handledAt)}
      </p>
    {/if}
  </section>

  <section class="flex flex-col gap-3">
    <h3 class="text-xs font-semibold tracking-wide text-dark-2 uppercase">Known issue</h3>

    {#if row.bugId}
      <p class="text-sm">
        Linked to issue
        <a href={`${civitaiUrl}/issues`} target="_blank" rel="noreferrer" class={LINK_CLASS}>
          #{row.bugId}
        </a>
        — {row.bugTitle ?? 'untitled'}
        <span class="text-dark-2">({row.bugStatus ?? 'unknown status'})</span>
      </p>
      {#if siblings.length}
        <div class="flex flex-col gap-1">
          <p class="text-sm text-dark-2">
            {siblings.length} other report{siblings.length === 1 ? '' : 's'} linked to this issue
          </p>
          <ul class="flex flex-col gap-1 text-sm">
            {#each siblings as sibling (sibling.id)}
              <li>
                <a href={urlWith(page.url, { open: sibling.id })} class={LINK_CLASS}>
                  {shortAge(sibling.createdAt)} · {sibling.area}
                </a>
                <span class="text-dark-2"> — {sibling.message.split('\n')[0]}</span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    {:else if canPromote}
      <!-- 🔴 No ClickUp call, because there is none to make: this repo holds a ClickUp WEBHOOK
           secret and nothing else — no token, no client, no list id. The task is still created by
           hand and its URL pasted onto the issue. The issue lands UNPUBLISHED, so promoting cannot
           put a reporter's words on the public board. -->
      <form method="POST" action="?/promote" use:enhance={promoteForm.enhance} class="flex flex-col gap-3">
        <input type="hidden" name="id" value={row.id} />

        {#if attachMode}
          <div class="flex flex-col gap-1">
            <Label for={`bug-${row.id}`} class="text-xs text-dark-2">Existing issue number</Label>
            <Input id={`bug-${row.id}`} name="bugId" inputmode="numeric" class="w-40" />
          </div>
        {:else}
          <div class="flex flex-col gap-1">
            <Label for={`title-${row.id}`} class="text-xs text-dark-2">
              Issue title — a summary, not the complaint
            </Label>
            <Input id={`title-${row.id}`} name="title" />
          </div>
          <div class="flex flex-col gap-1">
            <Label for={`summary-${row.id}`} class="text-xs text-dark-2">
              Summary — what the issue board shows
            </Label>
            <Textarea id={`summary-${row.id}`} name="summary" rows={2} />
          </div>
        {/if}

        <div class="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={promoteForm.submitting}>
            {attachMode ? 'Attach to issue' : 'Create issue'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onclick={() => {
              attachMode = !attachMode;
              promoteForm.error = null;
            }}
          >
            {attachMode ? 'Create a new issue instead' : 'Attach to an existing issue instead'}
          </Button>
        </div>
      </form>
      {#if promoteForm.error}
        <ErrorAlert message={promoteForm.error} />
      {/if}
    {:else}
      <p class="text-sm text-dark-2">
        Not linked to an issue. Promoting needs the “Promote feedback to a Known Issue” permission.
      </p>
    {/if}
  </section>
</div>
