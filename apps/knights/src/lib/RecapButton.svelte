<script lang="ts">
  import { goto, invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import type { SubmitFunction } from '@sveltejs/kit';
  import Icon from './Icon.svelte';
  import RecapDialog from './RecapDialog.svelte';
  import type { Recap } from './server/daily/daily.service';

  let { unseen }: { unseen: boolean } = $props();

  type Loaded = { recap: Recap | null };
  let loaded = $state<Loaded | null>(null);
  let loading = $state(false);
  let submitting = $state(false);
  let message = $state<string | null>(null);
  let failed = $state(false);

  // The recap is read when the button is clicked, not with every page, so it is always today's figures.
  async function show() {
    if (loading) return;
    loading = true;
    message = null;
    failed = false;
    try {
      const response = await fetch('/recap');
      if (!response.ok) throw new Error(String(response.status));
      loaded = (await response.json()) as Loaded;
    } catch {
      loaded = { recap: null };
      message = 'Try again in a moment.';
      failed = true;
    } finally {
      loading = false;
    }
  }

  // The dialog's form posts to /recap, which answers JSON rather than a form action result, so the post is made here.
  const submit: SubmitFunction = ({ cancel, formData, submitter }) => {
    cancel();
    const begin = submitter?.getAttribute('name') === 'begin';
    // Nothing was loaded, so nothing was seen: closing must not dismiss the day.
    if (failed) {
      loaded = null;
      if (begin && page.url.pathname !== '/play') void goto('/play');
      return;
    }
    submitting = true;
    fetch('/recap', { method: 'POST', body: formData })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        loaded = null;
        await invalidate('app:recap');
        if (begin && page.url.pathname !== '/play') await goto('/play');
      })
      .catch(() => (message = 'Could not save that. Try again.'))
      .finally(() => (submitting = false));
  };
</script>

<button
  type="button"
  class="recap-button"
  aria-label={unseen ? 'Daily recap, not yet seen' : 'Daily recap'}
  title="Daily recap"
  aria-busy={loading}
  onclick={show}
>
  <Icon name="scroll-text" size={18} />
  {#if unseen}<span class="dot" aria-hidden="true"></span>{/if}
</button>

{#if loaded}
  <RecapDialog
    recap={loaded.recap}
    action="/recap"
    {message}
    {submitting}
    {submit}
  />
{/if}

<style>
  .recap-button {
    position: relative;
    display: grid;
    flex: none;
    place-items: center;
    width: 32px;
    min-height: 32px;
    padding: 0;
    border: 1px solid var(--io-gold-muted);
    border-radius: 999px;
    background: var(--io-bg);
    color: var(--io-gold);
  }
  .recap-button:hover {
    background: var(--io-surface);
  }
  .dot {
    position: absolute;
    top: -1px;
    right: -1px;
    width: 9px;
    height: 9px;
    border: 2px solid var(--io-surface);
    border-radius: 50%;
    background: var(--io-crimson);
    box-sizing: content-box;
  }
</style>
