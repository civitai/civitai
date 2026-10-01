<script lang="ts" module>
  export type NoteRow = {
    id: number;
    content: string | null;
    author: string | null;
    at: Date | string | null;
    /** Whether this moderator may edit the row. Advice for the UI — the action re-checks in SQL. */
    isMine: boolean;
  };
</script>

<script lang="ts">
  import { enhance } from '$app/forms';
  import { FormState } from '$lib/form-state.svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import ErrorAlert from './ErrorAlert.svelte';

  /**
   * Shared by User Lookup's `UserNotes` and Model Lookup's `ModelNotes` — two tables that spell the
   * column and the author differently, hence `field`.
   *
   * `reset: false` is required: the textarea is pre-filled from server state, and a reset blanks it so
   * the next submit posts `''` over the note. See `reset` in `form-state.svelte.ts`.
   */
  let {
    notes,
    empty,
    editAction,
    field,
    onSaved,
    maxlength,
  }: {
    notes: NoteRow[];
    empty: string;
    editAction: string;
    /** The textarea's `name`, which is the column the action expects. */
    field: string;
    /** Refetch: the rows come from the caller's own fetch, not from `load`. */
    onSaved: () => void;
    maxlength?: number;
  } = $props();

  let editing = $state<number | null>(null);

  const form = new FormState({
    reset: false,
    onSuccess: () => {
      editing = null;
      onSaved();
    },
  });
</script>

{#if form.error}
  <ErrorAlert class="mb-3" message={form.error} />
{/if}

{#if notes.length === 0}
  <p class="text-sm text-dark-2">{empty}</p>
{:else}
  <ul class="space-y-3">
    {#each notes as note (note.id)}
      <li class="border-b border-dark-4 pb-3 last:border-0 last:pb-0">
        {#if editing === note.id}
          <form method="POST" action={editAction} use:enhance={form.enhance}>
            <input type="hidden" name="id" value={note.id} />
            <Textarea name={field} rows={3} value={note.content ?? ''} {maxlength} required />
            <div class="mt-2 flex gap-2">
              <Button type="submit" size="sm" disabled={form.submitting}>Save</Button>
              <Button type="button" size="sm" variant="outline" onclick={() => (editing = null)}>
                Cancel
              </Button>
            </div>
          </form>
        {:else if note.content?.trim()}
          <p class="text-sm whitespace-pre-wrap text-dark-0">{note.content}</p>
        {:else}
          <!-- `UserNotes.notes` is nullable, and a blank body reads as text that failed to load. -->
          <p class="text-sm text-dark-2 italic">Empty note.</p>
        {/if}
        {#if editing !== note.id}
          <div class="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs text-dark-2">
            <span>{note.author ?? 'unknown'}</span>
            <span>{dateTime(note.at)}</span>
            {#if note.isMine}
              <button type="button" class={LINK_CLASS} onclick={() => (editing = note.id)}>
                edit
              </button>
            {/if}
          </div>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
