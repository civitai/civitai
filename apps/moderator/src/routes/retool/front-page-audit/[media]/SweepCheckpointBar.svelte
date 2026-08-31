<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, dateTime, relativeTime } from '$lib/format';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // Marking the sweep RELOADS — the resume point moves, so the window on screen is no longer the window
  // the page would fetch. Rating a card deliberately does not reload, which is why this is its own state.
  const sweepForm = new FormState({ onSuccess: null, reload: true });

  // Omitting `hours` is what opts back IN to the shared point (see the load).
  const resumeShared = () =>
    goto(`?level=${data.nsfwLevels.join(',')}&order=${data.order}`, { keepFocus: true });

  const lastCheckedAt = $derived(
    data.items.length ? new Date(data.items[data.items.length - 1].createdAt).toISOString() : ''
  );

  // The sweep resumes from the OLDEST selected rating's point, so that is the one the banner has to
  // name — quoting a newer one would describe a window narrower than the one actually running.
  const oldest = $derived(
    [...data.checkpoints].sort(
      (a, b) => new Date(a.lastCheckedAt).getTime() - new Date(b.lastCheckedAt).getTime()
    )[0]
  );
  const behindCount = $derived(data.nsfwLevels.length - data.checkpoints.length);

  // A resume point is normally hours old. One that is weeks or months old means a rating nobody sweeps,
  // and the sweep is about to open that whole span — worth saying before the moderator starts, not
  // leaving them to read it off a date.
  const STALE_AFTER_DAYS = 7;
  const stale = $derived(
    !!oldest &&
      Date.now() - new Date(oldest.lastCheckedAt).getTime() > STALE_AFTER_DAYS * 86_400_000
  );
</script>

<div class="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-dark-2">
  {#if data.usingCheckpoint && oldest}
    <span>
      Resuming the shared sweep from {dateTime(oldest.lastCheckedAt)} ({relativeTime(
        oldest.lastCheckedAt
      )})
      {#if oldest.isSplit}
        · set by the Split control on Queue Stats
      {:else if oldest.username}
        · last marked by {oldest.username}{/if}
      {#if oldest.buttonPressedTime}
        · {dateTime(oldest.buttonPressedTime)}{/if}
      <!-- Each rating keeps its own point, so a mixed sweep runs from the furthest-behind one and the
           rest are re-shown rather than re-swept. Saying so stops that reading as duplicated work. -->
      {#if data.nsfwLevels.length > 1}
        · the oldest of {data.nsfwLevels.length} ratings{#if behindCount > 0}, {behindCount} never marked{/if}
      {/if}
    </span>
    {#if stale}
      <span class="text-amber-300">
        That point has not moved in {relativeTime(oldest.lastCheckedAt).replace(' ago', '')} — this
        sweep covers everything since. Narrow the window if you only want recent arrivals.
      </span>
    {/if}
  {:else if oldest}
    <span>
      Using your own {data.hours}h window. The shared point sits at
      {dateTime(oldest.lastCheckedAt)} ({relativeTime(oldest.lastCheckedAt)}).
      <button type="button" class={LINK_CLASS} onclick={resumeShared}>Resume the shared sweep</button>.
    </span>
  {:else}
    <span>No shared resume point for these ratings yet — marking a sweep creates one.</span>
  {/if}

  <!-- Retool's green Log button. Offered only on a sweep that STARTED from the shared point: advancing
       it from a private window would silently discard everything between the two. -->
  {#if data.canAct && data.usingCheckpoint && lastCheckedAt}
    <form method="POST" action="?/markSwept" use:enhance={sweepForm.enhance}>
      <input type="hidden" name="nsfwLevel" value={data.nsfwLevels.join(',')} />
      <input type="hidden" name="order" value={data.order} />
      <input type="hidden" name="fromCheckpoint" value="1" />
      <input type="hidden" name="lastCheckedAt" value={lastCheckedAt} />
      <Button type="submit" size="xs" variant="outline" disabled={sweepForm.submitting}>
        {sweepForm.submitting ? 'Marking…' : 'Mark swept up to here'}
      </Button>
    </form>
  {/if}
</div>
