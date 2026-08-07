<script lang="ts">
  import { browser } from '$app/environment';
  import { applyAction, enhance } from '$app/forms';
  import type { ActionResult } from '@sveltejs/kit';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import type { FormResult } from './form-result';
  import { fetchMemory } from './user-memory';

  let {
    userId,
    canAct,
    form,
  }: { userId: number; canAct: boolean; form: FormResult } = $props();

  const FLAGS = [
    ['spamWhitelist', 'Spam whitelist', 'Exempt from spam heuristics.'],
    ['deservedMute', 'Deserved mute', 'A past mute was judged earned.'],
  ] as const;

  const error = $derived(form?.scope === 'notes' ? form.error : null);

  // Bumped after a write so the derived promise refetches — the data lives in the moderator database,
  // not in `data`, so invalidating the page load would not bring it back.
  let version = $state(0);

  const memory = $derived(browser ? fetchMemory(userId, version) : null);

  let editing = $state<number | null>(null);
  let adding = $state(false);
  let submitting = $state(false);

  // applyAction populates `form` — without it "You can only edit your own notes." never reaches the UI
  // and a rejected edit looks like a successful one.
  //
  // Deliberately NOT invalidateAll(): nothing a note write changes comes from `load`, and invalidating
  // re-runs all eight lookup queries plus the account fetch behind them, including a 744M-row scan.
  const afterWrite =
    () =>
    async ({ result }: { result: ActionResult }) => {
      await applyAction(result);
      if (result.type === 'success') {
        editing = null;
        adding = false;
        version += 1;
      }
      submitting = false;
    };

  const onSubmit = () => {
    submitting = true;
    return afterWrite();
  };
</script>

<section class="mb-4 grid gap-4 lg:grid-cols-2">
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <div class="mb-3 flex items-baseline justify-between gap-3">
      <h3 class="text-sm font-semibold text-white">Moderator notes</h3>
      {#if !adding}
        <Button size="sm" variant="outline" onclick={() => (adding = true)}>Add note</Button>
      {/if}
    </div>

    {#if error}
      <div
        class="mb-3 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
        role="alert"
      >
        {error}
      </div>
    {/if}

    {#if adding}
      <form method="POST" action="?/addNote" use:enhance={onSubmit} class="mb-4">
        <input type="hidden" name="userId" value={userId} />
        <Textarea name="notes" rows={3} placeholder="What should the next moderator know?" required />
        <div class="mt-2 flex gap-2">
          <Button type="submit" size="sm" disabled={submitting}>Save</Button>
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
                <form method="POST" action="?/setModerationFlag" use:enhance={onSubmit}>
                  <input type="hidden" name="userId" value={userId} />
                  <input type="hidden" name="flag" value={flag} />
                  <input type="hidden" name="value" value={on ? 'false' : 'true'} />
                  <button type="submit" disabled={submitting} class="text-xs {LINK_CLASS}">
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
                <form method="POST" action="?/editNote" use:enhance={onSubmit}>
                  <input type="hidden" name="id" value={note.id} />
                  <Textarea name="notes" rows={3} value={note.notes ?? ''} required />
                  <div class="mt-2 flex gap-2">
                    <Button type="submit" size="sm" disabled={submitting}>Save</Button>
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
    <h3 class="mb-1 text-sm font-semibold text-white">Strikes</h3>
    <p class="mb-3 text-xs text-dark-2">
      Read-only — issuing a strike also notifies the user, which is not ported yet.
    </p>
    {#await memory}
      <p class="text-sm text-dark-2">Loading strikes…</p>
    {:then result}
      {#if !result}
        <p class="text-sm text-dark-2">Loading strikes…</p>
      {:else if result.strikes.length === 0}
        <p class="text-sm text-dark-2">No strikes on this account.</p>
      {:else}
        <ul class="space-y-2">
          {#each result.strikes as strike (strike.id)}
            <li class="text-sm">
              <div class="flex flex-wrap items-baseline gap-x-2">
                <Badge variant="destructive">strike</Badge>
                <span class="text-xs text-dark-2">
                  {strike.createdBy ?? 'unknown'} · {dateTime(strike.createdAt)}
                </span>
              </div>
              {#if strike.reason}
                <p class="text-dark-0">{strike.reason}</p>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {:catch}
      <p class="text-sm text-red-300">Could not load strikes.</p>
    {/await}
  </div>
</section>
