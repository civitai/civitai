<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';

  let { userId, username }: { userId: number; username: string | null } = $props();

  type Counts = Record<string, number>;

  let counts = $state<Counts | null>(null);
  let removed = $state<Counts | null>(null);
  let remaining = $state<number | null>(null);
  let confirm = $state('');

  const total = (c: Counts) => Object.values(c).reduce((a, b) => a + b, 0);
  const rows = (c: Counts) => Object.entries(c).filter(([, n]) => n > 0);

  const count = new FormState({
    reset: false,
    onSuccess: (data) => {
      counts = (data?.reactionCounts as Counts | undefined) ?? null;
      removed = null;
      remaining = null;
    },
  });

  // After any answer, including "could not confirm": the counts on screen are stale either way, and a
  // stale total under a live Remove button invites a second run on the wrong premise.
  const remove = new FormState({
    reset: false,
    onSuccess: (data) => {
      removed = (data?.reactionsRemoved as Counts | undefined) ?? null;
      remaining = (data?.reactionsRemaining as number | undefined) ?? null;
    },
    onSettled: () => {
      counts = null;
      confirm = '';
    },
  });

  const expected = $derived(username ?? String(userId));
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Remove all reactions</h3>
  <p class="mb-3 text-xs text-dark-2">
    For a data-subject request. Deletes every reaction this account made, on images, articles,
    posts, comments, reviews and bounty entries, and updates the counts they fed. Nothing is kept and
    it cannot be undone. Large accounts take more than one run.
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
        <strong>{remaining.toLocaleString()} image reactions remain</strong> — count and run again.
      {/if}
    </div>
  {/if}

  <form method="POST" action="?/countReactions" use:enhance={count.enhance} class="mb-3">
    <input type="hidden" name="userId" value={userId} />
    <Button type="submit" size="sm" variant="outline" disabled={count.submitting || remove.submitting}>
      {count.submitting ? 'Counting…' : 'Count reactions'}
    </Button>
  </form>

  {#if counts}
    {@const n = total(counts)}
    {#if n === 0}
      <p class="text-sm text-dark-2">This account has no reactions.</p>
    {:else}
      <ul class="mb-3 space-y-0.5 text-sm text-dark-1">
        {#each rows(counts) as [table, c] (table)}
          <li>{table}: {c.toLocaleString()}</li>
        {/each}
      </ul>
      <form method="POST" action="?/removeReactions" use:enhance={remove.enhance}>
        <input type="hidden" name="userId" value={userId} />
        <div class="rounded-md border border-red-500/40 bg-red-500/10 p-3">
          <label class="text-xs text-dark-2">
            Type <code class="text-dark-0">{expected}</code> to remove {n.toLocaleString()} reactions
            <Input
              name={username === null ? undefined : 'username'}
              bind:value={confirm}
              class="mt-1"
              autocomplete="off"
            />
          </label>
          <Button
            type="submit"
            size="sm"
            variant="destructive"
            class="mt-2"
            disabled={remove.submitting || confirm !== expected}
          >
            {remove.submitting ? 'Removing…' : 'Remove all reactions'}
          </Button>
        </div>
      </form>
    {/if}
  {/if}
</section>
