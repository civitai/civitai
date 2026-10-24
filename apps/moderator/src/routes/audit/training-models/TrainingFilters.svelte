<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { urlWith } from '$lib/url';

  let {
    filters,
  }: {
    filters: {
      username: string;
      workflowId: string;
      from?: string;
      to?: string;
      publishing: string;
    };
  } = $props();

  // `null` means "whatever the URL says"; a value is an edit since the last navigation. Derived rather
  // than mirrored: props only update once `goto` resolves, and this page's load is a three-query feed,
  // so a mirror drops typed text whenever any card action reloads behind it.
  let draftUsername = $state<string | null>(null);
  let draftWorkflowId = $state<string | null>(null);
  let draftFrom = $state<string | null>(null);
  let draftTo = $state<string | null>(null);
  const username = $derived(draftUsername ?? filters.username);
  const workflowId = $derived(draftWorkflowId ?? filters.workflowId);
  const from = $derived(draftFrom ?? filters.from ?? '');
  const to = $derived(draftTo ?? filters.to ?? '');

  // Drop a draft only once the URL AGREES with it. Clearing unconditionally discarded characters typed
  // while the debounced navigation was still in flight, and the pending timer then searched the reverted
  // value — both invisible in review, and both land exactly when the load is slow.
  $effect(() => {
    page.url.search;
    if (draftUsername === filters.username) draftUsername = null;
    if (draftWorkflowId === filters.workflowId) draftWorkflowId = null;
    if (draftFrom === (filters.from ?? '')) draftFrom = null;
    if (draftTo === (filters.to ?? '')) draftTo = null;
  });

  // A pending timer outlives this component: navigating away mid-type would otherwise yank the operator
  // back to the filtered list up to half a second later.
  $effect(() => () => clearTimeout(debounce));

  // Every filter change restarts paging: `cursor` names a position in the set being replaced. Whatever
  // is typed but unsubmitted goes WITH it — changing the dropdown used to throw the other four away.
  const navigate = (params: Record<string, string> = {}) =>
    goto(
      urlWith(page.url, {
        cursor: null,
        username: username.trim(),
        workflowId: workflowId.trim(),
        from,
        to,
        ...params,
      }),
      { keepFocus: true }
    );

  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    clearTimeout(debounce);
    navigate();
  };

  // The main app filtered as you typed (500ms). Kept, so the button is a shortcut rather than the only
  // way to apply a filter.
  let debounce: ReturnType<typeof setTimeout>;
  const typed = (apply: (value: string) => void) => (value: string) => {
    apply(value);
    clearTimeout(debounce);
    debounce = setTimeout(() => navigate(), 500);
  };

  const PUBLISHING = [
    ['all', 'All models'],
    ['blocked', 'Blocked from publishing'],
    ['allowed', 'Allowed to publish'],
  ] as const;

  const publishingLabel = $derived(
    PUBLISHING.find(([v]) => v === filters.publishing)?.[1] ?? 'All models'
  );
  const active = $derived(
    !!(filters.username || filters.workflowId || filters.from || filters.to) ||
      filters.publishing !== 'all'
  );
</script>

<form onsubmit={submit} class="mb-5 flex flex-wrap items-end gap-3">
  <div>
    <Label for="tm-username" class="text-xs text-dark-2">Username</Label>
    <Input id="tm-username" bind:value={() => username, typed((v) => (draftUsername = v))} class="mt-1 w-52" placeholder="Exact username" />
  </div>
  <div>
    <Label for="tm-workflow" class="text-xs text-dark-2">Workflow ID</Label>
    <Input id="tm-workflow" bind:value={() => workflowId, typed((v) => (draftWorkflowId = v))} class="mt-1 w-52" />
  </div>
  <div>
    <Label for="tm-from" class="text-xs text-dark-2">From</Label>
    <Input id="tm-from" type="date" bind:value={() => from, (v) => { draftFrom = v; navigate(); }} class="mt-1 w-40" />
  </div>
  <div>
    <Label for="tm-to" class="text-xs text-dark-2">To</Label>
    <Input id="tm-to" type="date" bind:value={() => to, (v) => { draftTo = v; navigate(); }} class="mt-1 w-40" />
  </div>
  <div>
    <Label for="tm-publishing" class="text-xs text-dark-2">Publishing</Label>
    <Select.Root
      type="single"
      bind:value={() => filters.publishing, (v) => navigate({ publishing: v ?? 'all' })}
    >
      <Select.Trigger id="tm-publishing" class="mt-1 w-52">{publishingLabel}</Select.Trigger>
      <Select.Content>
        {#each PUBLISHING as [value, label] (value)}
          <Select.Item {value}>{label}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>

  <Button type="submit" size="sm">Apply</Button>
  {#if active}
    <Button
      type="button"
      size="sm"
      variant="outline"
      onclick={() => goto(page.url.pathname, { keepFocus: true })}
    >
      Clear
    </Button>
  {/if}
</form>
