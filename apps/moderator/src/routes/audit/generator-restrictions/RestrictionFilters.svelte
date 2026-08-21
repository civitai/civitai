<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { urlWith } from '$lib/url';

  let { q, status }: { q: string; status: string } = $props();

  // Same staging as the other filter bars: rulings reload the page, and a mirrored prop would clear a
  // search the moderator had typed but not yet submitted.
  let draftTerm = $state<string | null>(null);
  const term = $derived(draftTerm ?? q);
  // Drop a draft only once the URL AGREES with it. Clearing unconditionally discarded characters typed
  // while the debounced navigation was still in flight, and the pending timer then searched the reverted
  // value — both invisible in review, and both land exactly when the load is slow.
  $effect(() => {
    page.url.search;
    if (draftTerm === q) draftTerm = null;
  });

  // A pending timer outlives this component: navigating away mid-type would otherwise yank the operator
  // back to the filtered list up to half a second later.
  $effect(() => () => clearTimeout(debounce));

  // Changing any filter drops `page` and `selected`: both name a row in the set being replaced.
  const navigate = (params: Record<string, string>) =>
    goto(urlWith(page.url, { page: null, selected: null, ...params }), { keepFocus: true });

  // The main app searched as you typed (300ms). The button stays as a shortcut.
  let debounce: ReturnType<typeof setTimeout>;
  const typed = (value: string) => {
    draftTerm = value;
    clearTimeout(debounce);
    debounce = setTimeout(() => navigate({ q: value.trim() }), 300);
  };

  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    clearTimeout(debounce);
    navigate({ q: term.trim() });
  };

  const STATUSES = ['Pending', 'Upheld', 'Overturned'];
</script>

<form onsubmit={submit} class="mb-4 flex flex-wrap items-end gap-3">
  <div>
    <Label for="restriction-q" class="text-xs text-dark-2">Username or user ID</Label>
    <Input id="restriction-q" bind:value={() => term, typed} class="mt-1 w-64" placeholder="Search…" />
  </div>
  <div>
    <Label for="restriction-status" class="text-xs text-dark-2">Status</Label>
    <Select.Root
      type="single"
      bind:value={() => status, (v) => navigate({ status: v ?? 'Pending' })}
    >
      <Select.Trigger id="restriction-status" class="mt-1 w-40">
        {status === 'any' ? 'Any status' : status}
      </Select.Trigger>
      <Select.Content>
        <Select.Item value="any">Any status</Select.Item>
        {#each STATUSES as s (s)}
          <Select.Item value={s}>{s}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
  <Button type="submit" size="sm">Search</Button>
</form>
