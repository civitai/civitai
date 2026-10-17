<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';

  let { userId, username }: { userId: number; username: string | null } = $props();

  type Counts = Record<string, number>;

  /** Pause between runs while image reactions remain: each run is a burst of CDC work downstream. */
  const NEXT_RUN_DELAY_MS = 3_000;

  let counts = $state<Counts | null>(null);
  let removed = $state<Counts | null>(null);
  let remaining = $state<number | null>(null);
  let confirm = $state('');
  // True from the first Remove until the last run settles, so the form stays mounted between runs.
  let running = $state(false);
  let stopRequested = $state(false);
  let removeForm = $state<HTMLFormElement | null>(null);

  const total = (c: Counts) => Object.values(c).reduce((a, b) => a + b, 0);
  const rows = (c: Counts) => Object.entries(c).filter(([, n]) => n > 0);
  const add = (a: Counts | null, b: Counts) => {
    const sum: Counts = { ...a };
    for (const [k, n] of Object.entries(b)) sum[k] = (sum[k] ?? 0) + n;
    return sum;
  };

  // Cleared when the count STARTS: a failed recount must not leave the previous total under a live
  // Remove button, nor an earlier removal's error above the new one.
  const count = new FormState({
    reset: false,
    onSubmit: () => {
      counts = null;
      removed = null;
      remaining = null;
      remove.error = null;
    },
    onSuccess: (data) => {
      counts = (data?.reactionCounts as Counts | undefined) ?? null;
    },
  });

  const finish = () => {
    running = false;
    stopRequested = false;
    counts = null;
    confirm = '';
  };

  // One request at a time: Enter in the readonly confirmation still submits the form mid-run.
  let inFlight = false;
  const remove = new FormState({
    reset: false,
    onSubmit: ({ cancel }) => {
      if (inFlight) return cancel();
      inFlight = true;
      running = true;
    },
    onSuccess: (data) => {
      removed = add(removed, (data?.reactionsRemoved as Counts | undefined) ?? {});
      remaining = (data?.reactionsRemaining as number | undefined) ?? null;
    },
    // A failure, a stop, or nothing left ends the loop; otherwise the same confirmed form runs again.
    onSettled: (result) => {
      inFlight = false;
      if (result.type === 'success' && remaining && !stopRequested)
        setTimeout(() => (stopRequested ? finish() : removeForm?.requestSubmit()), NEXT_RUN_DELAY_MS);
      else finish();
    },
  });

  const expected = $derived(username ?? String(userId));
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Remove all reactions</h3>
  <p class="mb-3 text-xs text-dark-2">
    For a data-subject request. Deletes every reaction this account made, on images, articles,
    posts, comments, reviews and bounty entries, and updates the counts they fed. Nothing is kept and
    it cannot be undone. A large account is removed in several runs, which continue on their own.
  </p>

  {#if count.error}
    <ErrorAlert class="mb-3" message={count.error} />
  {/if}
  {#if remove.error}
    <ErrorAlert class="mb-3" message={remove.error} />
  {/if}

  {#if removed}
    <div
      class="mb-3 rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-200"
      role="status"
    >
      Removed {total(removed).toLocaleString()} reaction{total(removed) === 1 ? '' : 's'}{rows(removed)
        .length
        ? ` (${rows(removed)
            .map(([t, n]) => `${t} ${n.toLocaleString()}`)
            .join(', ')})`
        : ''}.
      {#if remaining}
        {remaining.toLocaleString()} image reactions remain{running && !stopRequested
          ? ' — continuing…'
          : ' — count and run again.'}
      {/if}
    </div>
  {/if}

  {#if !running}
    <form method="POST" action="?/countReactions" use:enhance={count.enhance} class="mb-3">
      <input type="hidden" name="userId" value={userId} />
      <Button type="submit" size="sm" variant="outline" disabled={count.submitting}>
        {count.submitting ? 'Counting…' : 'Count reactions'}
      </Button>
    </form>
  {/if}

  {#if counts && total(counts) === 0}
    <p class="text-sm text-dark-2">This account has no reactions.</p>
  {:else if counts || running}
    {#if counts}
      <ul class="mb-3 space-y-0.5 text-sm text-dark-1">
        {#each rows(counts) as [table, c] (table)}
          <li>{table}: {c.toLocaleString()}</li>
        {/each}
      </ul>
    {/if}
    <form
      bind:this={removeForm}
      method="POST"
      action="?/removeReactions"
      use:enhance={remove.enhance}
    >
      <input type="hidden" name="userId" value={userId} />
      <div class="rounded-md border border-red-500/40 bg-red-500/10 p-3">
        <Label for="erase-reactions-confirm" class="text-xs text-dark-2">
          Type <code class="text-dark-0">{expected}</code> to remove
          {counts ? total(counts).toLocaleString() : 'all'} reactions
        </Label>
        <Input
          id="erase-reactions-confirm"
          name={username === null ? undefined : 'username'}
          bind:value={confirm}
          class="mt-1"
          autocomplete="off"
          readonly={running}
        />
        <div class="mt-2 flex gap-2">
          {#if running}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={stopRequested}
              onclick={() => (stopRequested = true)}
            >
              {stopRequested ? 'Stopping after this run…' : 'Stop'}
            </Button>
          {:else}
            <Button type="submit" size="sm" variant="destructive" disabled={confirm !== expected}>
              Remove all reactions
            </Button>
          {/if}
        </div>
      </div>
    </form>
  {/if}
</section>
