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
  import { urlWith, urlWithMulti } from '$lib/url';
  import { clearPaging } from '$lib/paging';

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

  // A filter change invalidates both the queue's page and the open account's image position, so it
  // clears both schemes — `clearPaging` owns which params those are. `user` survives: the open account
  // is not part of the filter.
  const navigate = (href: string) => {
    const url = new URL(href, pageState.url);
    clearPaging(url.searchParams);
    return goto(urlWith(url, { page: 1 }), { keepFocus: true });
  };

  function setStatuses(next: string[]) {
    draftStatuses = next;
    // emptyMeansAll: this page's load reads an ABSENT `?status=` as the Pending+Processing default, so
    // a cleared selection has to survive as an empty param or it silently reapplies that default.
    navigate(urlWithMulti(pageState.url, 'status', next, { emptyMeansAll: true }));
  }

  const setParam = (key: string, value: string) =>
    navigate(urlWith(pageState.url, { [key]: value || null }));

  const active = $derived(
    Boolean(reportedBy || reportedFrom || reportedTo) || pageState.url.searchParams.has('status')
  );

  const clearAll = () =>
    navigate(
      urlWith(pageState.url, {
        status: null,
        reportedBy: null,
        reportedFrom: null,
        reportedTo: null,
      })
    );
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
    <!-- Function binding, not a one-way prop: `Input.value` is `$bindable()` and the primitive writes
         to it, so a change whose resulting prop value is unchanged (clearing an already-absent param)
         latches the child's copy and the field keeps showing a value the query has dropped. -->
    <Input
      type="date"
      bind:value={() => reportedFrom, (v) => setParam('reportedFrom', v)}
      class="h-7 w-36"
    />
  </label>

  <label class="flex items-center gap-1 text-dark-2">
    To
    <Input
      type="date"
      bind:value={() => reportedTo, (v) => setParam('reportedTo', v)}
      class="h-7 w-36"
    />
  </label>

  {#if active}
    <Button size="xs" variant="outline" onclick={clearAll}>Clear</Button>
  {/if}
</div>
