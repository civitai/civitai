<script lang="ts">
  import { goto } from '$app/navigation';
  import { page as pageState } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import {
    ToggleGroup,
    ToggleGroupItem,
  } from '@civitai/ui/components/ui/toggle-group/index.js';
  import { reportStatuses } from '$lib/reports';

  let {
    statuses,
    reportedBy,
    reportedFrom,
    reportedTo,
  }: {
    statuses: string[];
    reportedBy: string;
    reportedFrom: string;
    reportedTo: string;
  } = $props();

  // `null` means "whatever the URL says"; a value is an edit made since the last navigation. Derived
  // rather than copied out of the props, so there is no initial-value capture to go stale — and staged
  // rather than read straight back off the props, because those only update once `goto` resolves and
  // this page's queue query is slow enough that two quick chip clicks would both compute from the same
  // set and silently drop the first toggle.
  let draftStatuses = $state<string[] | null>(null);
  let draftReporter = $state<string | null>(null);
  const picked = $derived(draftStatuses ?? statuses);
  const reporter = $derived(draftReporter ?? reportedBy);
  $effect(() => {
    pageState.url.search;
    draftStatuses = null;
    draftReporter = null;
  });

  // Every filter change resets to page 1 and drops the cursor: both index a queue that no longer
  // exists once the filter moved. `user` survives — the open account is not part of the filter.
  function apply(mutate: (params: URLSearchParams) => void) {
    const params = new URLSearchParams(pageState.url.search);
    mutate(params);
    params.set('page', '1');
    params.delete('cursor');
    goto(`${pageState.url.pathname}?${params}`, { keepFocus: true });
  }

  // An empty `?status=` is how "every status" is said out loud — dropping the param instead would fall
  // back to the Pending+Processing default and read as the filter having been ignored.
  function setStatuses(next: string[]) {
    draftStatuses = next;
    apply((params) => {
      params.delete('status');
      if (next.length === 0) params.set('status', '');
      else next.forEach((s) => params.append('status', s));
    });
  }

  const setParam = (key: string, value: string) =>
    apply((params) => (value ? params.set(key, value) : params.delete(key)));

  const active = $derived(
    Boolean(reportedBy || reportedFrom || reportedTo) || pageState.url.searchParams.has('status')
  );

  const clearAll = () =>
    apply((params) => {
      for (const key of ['status', 'reportedBy', 'reportedFrom', 'reportedTo']) params.delete(key);
    });
</script>

<div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
  <ToggleGroup
    type="multiple"
    bind:value={() => picked, (v) => setStatuses(v as string[])}
    size="sm"
  >
    {#each reportStatuses as s (s)}
      <ToggleGroupItem value={s} aria-label={s}>{s}</ToggleGroupItem>
    {/each}
  </ToggleGroup>

  <label class="flex items-center gap-1 text-dark-2">
    Reporter
    <Input
      bind:value={() => reporter, (v) => (draftReporter = v)}
      placeholder="username"
      class="h-7 w-32"
      onchange={() => setParam('reportedBy', reporter.trim())}
    />
  </label>

  <label class="flex items-center gap-1 text-dark-2">
    From
    <Input
      type="date"
      value={reportedFrom}
      class="h-7 w-36"
      onchange={(e) => setParam('reportedFrom', e.currentTarget.value)}
    />
  </label>

  <label class="flex items-center gap-1 text-dark-2">
    To
    <Input
      type="date"
      value={reportedTo}
      class="h-7 w-36"
      onchange={(e) => setParam('reportedTo', e.currentTarget.value)}
    />
  </label>

  {#if active}
    <Button size="xs" variant="outline" onclick={clearAll}>Clear</Button>
  {/if}
</div>
