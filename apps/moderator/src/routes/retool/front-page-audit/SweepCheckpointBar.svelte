<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // Marking the sweep RELOADS — the resume point moves, so the window on screen is no longer the window
  // the page would fetch. Rating a card deliberately does not reload, which is why this is its own state.
  const sweepForm = new FormState({ onSuccess: null, reload: true });

  // Omitting `hours` is what opts back IN to the shared point (see the load).
  const resumeShared = () =>
    goto(`?level=${data.nsfwLevel}&order=${data.order}&media=${data.media}`, { keepFocus: true });

  const lastCheckedAt = $derived(
    data.items.length ? new Date(data.items[data.items.length - 1].createdAt).toISOString() : ''
  );
</script>

<div class="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-dark-2">
  {#if data.usingCheckpoint && data.checkpoint}
    <span>
      Resuming the shared sweep from {dateTime(data.checkpoint.lastCheckedAt)}
      {#if data.checkpoint.isSplit}
        · set by the Split control on Queue Stats
      {:else if data.checkpoint.username}
        · last marked by {data.checkpoint.username}{/if}
      {#if data.checkpoint.buttonPressedTime}
        · {dateTime(data.checkpoint.buttonPressedTime)}{/if}
    </span>
  {:else if data.checkpoint}
    <span>
      Using your own {data.hours}h window. The shared point sits at
      {dateTime(data.checkpoint.lastCheckedAt)}.
      <button type="button" class={LINK_CLASS} onclick={resumeShared}>Resume the shared sweep</button>.
    </span>
  {:else}
    <span>No shared resume point for this rating yet — marking a sweep creates one.</span>
  {/if}

  <!-- Retool's green Log button. Offered only on a sweep that STARTED from the shared point: advancing
       it from a private window would silently discard everything between the two. -->
  {#if data.canAct && data.usingCheckpoint && lastCheckedAt}
    <form method="POST" action="?/markSwept" use:enhance={sweepForm.enhance}>
      <input type="hidden" name="nsfwLevel" value={data.nsfwLevel} />
      <input type="hidden" name="order" value={data.order} />
      <input type="hidden" name="media" value={data.media} />
      <input type="hidden" name="fromCheckpoint" value="1" />
      <input type="hidden" name="lastCheckedAt" value={lastCheckedAt} />
      <Button type="submit" size="xs" variant="outline" disabled={sweepForm.submitting}>
        {sweepForm.submitting ? 'Marking…' : 'Mark swept up to here'}
      </Button>
    </form>
  {/if}
</div>
