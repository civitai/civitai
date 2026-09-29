<script lang="ts">
  import { browser } from '$app/environment';
  import { enhance } from '$app/forms';
  import { FormState } from '$lib/form-state.svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import ModeratorNoteList from '$lib/components/ModeratorNoteList.svelte';
  import { NOTE_MAX, fetchModelNotes } from './model-notes';

  let { modelId }: { modelId: number } = $props();

  // Not `reload: true`: the notes come from the moderator database, so invalidating would re-run the
  // whole model lookup and still not refetch them.
  let version = $state(0);

  const notes = $derived(browser ? fetchModelNotes(modelId, version) : null);

  let adding = $state(false);

  const form = new FormState({
    onSuccess: () => {
      adding = false;
      version += 1;
    },
  });
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="mb-3 flex items-baseline justify-between gap-3">
    <h3 class="text-sm font-semibold text-white">Moderator notes</h3>
    {#if !adding}
      <Button size="sm" onclick={() => (adding = true)}>Add note</Button>
    {/if}
  </div>

  {#if form.error}
    <ErrorAlert class="mb-3" message={form.error} />
  {/if}

  {#if adding}
    <form method="POST" action="?/addNote" use:enhance={form.enhance} class="mb-4">
      <input type="hidden" name="modelId" value={modelId} />
      <Textarea
        name="content"
        rows={3}
        maxlength={NOTE_MAX}
        placeholder="What should the next moderator know about this model?"
        required
      />
      <div class="mt-2 flex gap-2">
        <Button type="submit" size="sm" disabled={form.submitting}>Save</Button>
        <Button type="button" size="sm" variant="outline" onclick={() => (adding = false)}>
          Cancel
        </Button>
      </div>
    </form>
  {/if}

  {#await notes}
    <p class="text-sm text-dark-2">Loading notes…</p>
  {:then rows}
    {#if !rows}
      <p class="text-sm text-dark-2">Loading notes…</p>
    {:else}
      <ModeratorNoteList
        notes={rows.map((n) => ({
          id: n.id,
          content: n.content,
          author: n.createdBy,
          at: n.createdAt,
          isMine: n.isMine,
        }))}
        empty="No notes on this model."
        editAction="?/editNote"
        field="content"
        maxlength={NOTE_MAX}
        onSaved={() => (version += 1)}
      />
    {/if}
  {:catch}
    <p class="text-sm text-red-300">Could not load notes.</p>
  {/await}
</section>
