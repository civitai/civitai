<script lang="ts">
  import { browser } from '$app/environment';
  import { enhance } from '$app/forms';
  import { FormState } from '$lib/form-state.svelte';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { fetchMemory } from './user-memory';
  import CannedReasonPicker from '$lib/components/CannedReasonPicker.svelte';
  import StrikeList from '$lib/components/StrikeList.svelte';
  import { STRIKE_REASONS } from '$lib/moderation-reasons';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';

  let {
    userId,
    canAct,
  }: { userId: number; canAct: boolean } = $props();

  const FLAGS = [
    ['spamWhitelist', 'Spam whitelist', 'Exempt from spam heuristics.'],
    ['deservedMute', 'Deserved mute', 'A past mute was judged earned.'],
  ] as const;

  // Bumped after a write so the derived promise refetches — the data lives in the moderator database,
  // not in `data`, so invalidating the page load would not bring it back.
  let version = $state(0);

  const memory = $derived(browser ? fetchMemory(userId, version) : null);

  let editing = $state<number | null>(null);
  let adding = $state(false);
  let striking = $state(false);
  let strikeReason = $state('');

  // One per column, so each card shows only its own refusal. No `reload` on notes: nothing they write
  // comes from `load`, and invalidating re-runs the whole lookup plus the account fetch behind it,
  // including a 744M-row scan.
  const notesForm = new FormState({
    onSuccess: () => {
      editing = null;
      adding = false;
      version += 1;
    },
  });

  // A strike DOES change `load` — the header's active-strike chip reads it — so this one pays the
  // invalidation cost, as the User Reports strike form already does.
  const strikeForm = new FormState({
    reload: true,
    onSuccess: () => {
      striking = false;
      version += 1;
    },
    // A strike that recorded but could not notify comes back as a failure carrying the message. The
    // row exists, so the list has to refetch even though this is not a success.
    onSettled: (result) => {
      if (result.type === 'failure' && result.status === 200) {
        striking = false;
        version += 1;
      }
    },
  });
</script>

<section class="mb-4 grid gap-4 lg:grid-cols-2">
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <div class="mb-3 flex items-baseline justify-between gap-3">
      <h3 class="text-sm font-semibold text-white">Moderator notes</h3>
      {#if !adding}
        <Button size="sm" onclick={() => (adding = true)}>Add note</Button>
      {/if}
    </div>

    {#if notesForm.error}
      <ErrorAlert class="mb-3" message={notesForm.error} />
    {/if}

    {#if adding}
      <form method="POST" action="?/addNote" use:enhance={notesForm.enhance} class="mb-4">
        <input type="hidden" name="userId" value={userId} />
        <Textarea name="notes" rows={3} placeholder="What should the next moderator know?" required />
        <div class="mt-2 flex gap-2">
          <Button type="submit" size="sm" disabled={notesForm.submitting}>Save</Button>
          <Button type="button" size="sm" variant="outline" onclick={() => (adding = false)}>
            Cancel
          </Button>
        </div>
      </form>
    {/if}

    {#await memory}
      <p class="text-sm text-dark-2">Loading notes…</p>
    {:then result}
      {#if result}
        <!-- Both flags live on the note rows but describe the ACCOUNT, and until now nothing read
             them — a whitelisted account looked identical to one that had never been reviewed. -->
        <div class="mb-4 flex flex-wrap gap-x-4 gap-y-2 border-b border-dark-4 pb-3">
          {#each FLAGS as [flag, label, hint] (flag)}
            {@const on = result.flags[flag]}
            <div class="flex items-baseline gap-2">
              <Badge variant={on ? 'default' : 'secondary'}>{label}: {on ? 'yes' : 'no'}</Badge>
              {#if canAct}
                <form method="POST" action="?/setModerationFlag" use:enhance={notesForm.enhance}>
                  <input type="hidden" name="userId" value={userId} />
                  <input type="hidden" name="flag" value={flag} />
                  <input type="hidden" name="value" value={on ? 'false' : 'true'} />
                  <button type="submit" disabled={notesForm.submitting} class="text-xs {LINK_CLASS}">
                    {on ? 'clear' : 'set'}
                  </button>
                </form>
              {/if}
              <span class="text-xs text-dark-2">{hint}</span>
            </div>
          {/each}
        </div>
      {/if}

      {#if !result}
        <p class="text-sm text-dark-2">Loading notes…</p>
      {:else if result.notes.length === 0}
        <p class="text-sm text-dark-2">No notes on this account.</p>
      {:else}
        <ul class="space-y-3">
          {#each result.notes as note (note.id)}
            <li class="border-b border-dark-4 pb-3 last:border-0 last:pb-0">
              {#if editing === note.id}
                <form method="POST" action="?/editNote" use:enhance={notesForm.enhance}>
                  <input type="hidden" name="id" value={note.id} />
                  <Textarea name="notes" rows={3} value={note.notes ?? ''} required />
                  <div class="mt-2 flex gap-2">
                    <Button type="submit" size="sm" disabled={notesForm.submitting}>Save</Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onclick={() => (editing = null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              {:else}
                <p class="text-sm whitespace-pre-wrap text-dark-0">{note.notes}</p>
                <div class="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs text-dark-2">
                  <span>{note.lastUpdateBy ?? 'unknown'}</span>
                  <span>{dateTime(note.lastUpdate)}</span>
                  {#if note.isMine}
                    <button
                      type="button"
                      class={LINK_CLASS}
                      onclick={() => (editing = note.id)}
                    >
                      edit
                    </button>
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {:catch}
      <p class="text-sm text-red-300">Could not load notes.</p>
    {/await}
  </div>

  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <div class="mb-1 flex items-baseline justify-between gap-3">
      <h3 class="text-sm font-semibold text-white">Strikes</h3>
      {#if canAct && !striking}
        <Button size="sm" onclick={() => (striking = true)}>Issue strike</Button>
      {/if}
    </div>
    <p class="mb-3 text-xs text-dark-2">Issuing a strike notifies the user.</p>

    {#if strikeForm.error}
      <ErrorAlert class="mb-3" message={strikeForm.error} />
    {/if}

    {#if striking}
      <form method="POST" action="?/addStrike" use:enhance={strikeForm.enhance} class="mb-4">
        <input type="hidden" name="userId" value={userId} />
        <CannedReasonPicker reasons={STRIKE_REASONS} idPrefix="strike" bind:value={strikeReason} />
        <div class="mt-2 flex gap-2">
          <Button type="submit" size="sm" variant="destructive" disabled={strikeForm.submitting}>
            {strikeForm.submitting ? 'Working…' : 'Issue strike'}
          </Button>
          <Button type="button" size="sm" variant="outline" onclick={() => (striking = false)}>
            Cancel
          </Button>
        </div>
      </form>
    {/if}

    {#await memory}
      <p class="text-sm text-dark-2">Loading strikes…</p>
    {:then result}
      {#if !result}
        <p class="text-sm text-dark-2">Loading strikes…</p>
      {:else if !result.liveStrikes}
        <p class="text-sm text-red-300">
          Could not check strikes — treat as unknown, not none.
        </p>
      {:else}
        <StrikeList strikes={result.liveStrikes} empty="No strikes on this account." />
      {/if}
    {:catch}
      <p class="text-sm text-red-300">Could not load strikes.</p>
    {/await}
  </div>
</section>
