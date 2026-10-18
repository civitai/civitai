<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import ConfirmButton from '$lib/components/ConfirmButton.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { dateTime, LINK_CLASS } from '$lib/format';
  import { ITEM_DEFINITION_STATUS } from '$lib/mystery-box';

  let {
    box,
    snapshots,
    civitaiUrl,
    dirty,
  }: {
    box: { id: number; status: string; version: number };
    civitaiUrl: string;
    /** The editor holds unsaved work; these writes reload the page and would discard it. */
    dirty: boolean;
    snapshots: { version: number; createdAt: Date; createdById: number | null }[];
  } = $props();

  const recording = new FormState({ onSuccess: null, reload: true });
  const archiving = new FormState({ onSuccess: null, reload: true });
  const live = $derived(box.status !== ITEM_DEFINITION_STATUS.draft);
  const hasCurrentSnapshot = $derived(snapshots.some((s) => s.version === box.version));
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="flex flex-wrap items-center gap-3">
    <Badge variant="outline">{box.status}</Badge>
    <span class="text-sm text-dark-0">Version {box.version}</span>
    {#if live}
      <a class="text-sm {LINK_CLASS}" href="{civitaiUrl}/mystery-boxes/{box.id}" target="_blank" rel="noreferrer">
        Public odds page ↗
      </a>
    {/if}
    {#if box.status === ITEM_DEFINITION_STATUS.published}
      <form method="POST" action="?/archive" use:enhance={archiving.enhance} class="ml-auto">
        <ConfirmButton
          label="Archive"
          title="Archive this box?"
          description="It stops being sold. Every box already held still opens."
          disabled={archiving.submitting || dirty}
        />
      </form>
    {/if}
  </div>
  {#if dirty}
    <p class="mt-2 text-xs text-amber-300">Save or undo your edits below before archiving or recording.</p>
  {/if}
  {#if archiving.error}
    <ErrorAlert class="mt-3" message={archiving.error} />
  {/if}
  {#if box.status === ITEM_DEFINITION_STATUS.archived}
    <p class="mt-2 text-xs text-dark-2">Archived: no longer sold, and every held box still opens.</p>
  {/if}

  {#if live}
    {#if !hasCurrentSnapshot}
      <p class="mt-3 text-sm text-amber-300">
        Version {box.version} has no odds snapshot, so the public page says its history is incomplete.
        Recording a change below writes one.
      </p>
    {/if}
    <details class="mt-3">
      <summary class="text-sm text-dark-2">Odds history ({snapshots.length})</summary>
      <ul class="mt-2 space-y-1 text-xs text-dark-2">
        {#each snapshots as snapshot (snapshot.version)}
          <li>
            Version {snapshot.version}, {dateTime(snapshot.createdAt)}{snapshot.createdById
              ? ` by user ${snapshot.createdById}`
              : ''}
          </li>
        {/each}
      </ul>
    </details>

    <form method="POST" action="?/recordOutsideChange" use:enhance={recording.enhance} class="mt-3 rounded-lg border border-dark-4 p-3">
      <input type="hidden" name="expectedVersion" value={box.version} />
      <p class="mb-2 text-xs text-dark-2">
        A buyer draws only from cosmetics whose team (the cosmetic's <code>data.team</code>) is theirs.
        No screen edits that: it is set when an event's cosmetics are loaded, by SQL or a seed script.
        If a cosmetic in this box changed team that way, record it here so the site stops showing the
        old odds and the history gets a new version. Edits made in this editor record themselves.
      </p>
      <ConfirmButton
        label="Record a cosmetic change"
        title="Record a new version?"
        description="The public odds history gets a new version with the same tiers and contents."
        disabled={recording.submitting || dirty}
      />
      {#if recording.error}
        <ErrorAlert class="mt-2" message={recording.error} />
      {/if}
    </form>
  {/if}
</section>
