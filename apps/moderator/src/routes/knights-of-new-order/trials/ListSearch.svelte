<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { num } from '$lib/format';
  import { urlWith } from '$lib/url';

  let {
    text,
    error,
    total,
    noun,
  }: { text: string; error: string | null; total: number; noun: string } = $props();

  let draft = $state<string | null>(null);
  const value = $derived(draft ?? text);

  /** A new search is a new list, so it starts on page 1. */
  function search(q: string) {
    draft = null;
    void goto(urlWith(page.url, { q: q.trim(), page: null }), { keepFocus: true, noScroll: true });
  }
</script>

<form
  onsubmit={(event) => {
    event.preventDefault();
    search(value);
  }}
  class="mb-3 flex flex-wrap items-center gap-2"
>
  <Input
    name="q"
    {value}
    oninput={(e) => (draft = e.currentTarget.value)}
    class="w-80"
    placeholder="Search by image id or URL"
    aria-label="Search by image id or URL"
  />
  <Button type="submit" size="sm" variant="outline">Search</Button>
  {#if text}
    <Button type="button" size="sm" variant="ghost" onclick={() => search('')}>Clear</Button>
  {/if}
  <span class="text-sm text-dark-2">
    {num(total)}
    {noun}{text && !error ? ' found' : ''}
  </span>
</form>
{#if error}<ErrorAlert class="mb-3" message={error} />{/if}
