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
    placeholder = 'Search by image id or URL',
  }: { text: string; error: string | null; total: number; noun: string; placeholder?: string } =
    $props();

  // Writable derived: typing overrides it, and a new `text` from the URL (Back, pager, Clear) resets it.
  let value = $derived(text);

  function search(q: string) {
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
    oninput={(e) => (value = e.currentTarget.value)}
    class="w-80"
    {placeholder}
    aria-label={placeholder}
  />
  <Button type="submit" size="sm" variant="outline">Search</Button>
  {#if text}
    <Button type="button" size="sm" variant="ghost" onclick={() => search('')}>Clear</Button>
  {/if}
  {#if !error}
    <span class="text-sm text-dark-2">
      {num(total)}
      {noun}{text ? ' found' : ''}
    </span>
  {/if}
</form>
{#if error}<ErrorAlert class="mb-3" message={error} />{/if}
