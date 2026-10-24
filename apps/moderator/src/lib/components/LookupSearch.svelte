<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';

  // The search box for the Retool lookup pages. Three of them had identical copies of the state +
  // effect + navigation triple; the copies had NOT drifted, but there is no reason for a page to own it.
  //
  // It REPLACES the whole query string rather than merging params. Chat Audit depends on that: a new
  // search must drop `?chat=`, because the opened transcript belongs to the previous result set. Do not
  // add param preservation "for generality" — it would silently break that.
  // `path` sends the search somewhere other than the current route. Chat Audit needs it: its tabs are
  // sub-routes, and searching from Stats must land on Chats rather than re-rendering Stats with a term
  // it does not use.
  let { q, placeholder, path }: { q: string; placeholder: string; path?: string } = $props();

  // Local copy so typing doesn't navigate; re-synced whenever a search lands (incl. back/forward).
  let term = $state(untrack(() => q));
  $effect(() => {
    term = q;
  });

  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    const value = term.trim();
    const base = path ?? '';
    goto(value ? `${base}?q=${encodeURIComponent(value)}` : base || '?', { keepFocus: true });
  };
</script>

<form onsubmit={submit} class="mb-6 flex max-w-xl gap-2">
  <Input bind:value={term} {placeholder} class="flex-1" />
  <Button type="submit">Search</Button>
</form>
