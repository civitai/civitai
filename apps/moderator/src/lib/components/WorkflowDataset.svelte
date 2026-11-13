<script lang="ts">
  import TrainingAssetGrid from '$lib/components/TrainingAssetGrid.svelte';
  import { LINK_CLASS, plural } from '$lib/format';
  import type { TrainingAsset } from '$lib/training-media';
  import type {
    DatasetItemState,
    WorkflowDatasetItem,
  } from '$lib/server/training-moderation.service';

  let {
    workflowId,
    items,
    itemStates,
  }: {
    workflowId: string;
    items: WorkflowDatasetItem[];
    itemStates: Promise<Record<number, DatasetItemState>>;
  } = $props();

  // Items are served by position through this app, never from a URL the workflow carries.
  const itemUrl = (index: number) =>
    `/api/training-workflow-blob/${encodeURIComponent(workflowId)}/${index}`;
  const label = (item: WorkflowDatasetItem) => `Item ${item.index + 1}`;

  const stored = $derived(items.filter((item) => item.blobKey));
  const unserved = $derived(items.length - stored.length);

  /** Not shown as a tile or a link: the state says there is nothing to show. */
  const hidden = (state: DatasetItemState | undefined) =>
    state === 'blocked' || state === 'unavailable';
</script>

<!-- One rendering of the grid and the "open" links, for both a known and an unknown item state:
     every stored item that is not known to be hidden stays reachable either way. -->
{#snippet shown(states: Record<number, DatasetItemState>, anyHidden: boolean)}
  {@const assets = stored.flatMap((item): TrainingAsset[] =>
    item.media && !hidden(states[item.index])
      ? [{ url: itemUrl(item.index), name: label(item), ...item.media, caption: item.caption }]
      : []
  )}
  {@const other = stored.filter((item) => !item.media && !hidden(states[item.index]))}
  {#if assets.length}
    <TrainingAssetGrid {assets} preload="none" columns="grid-cols-2 sm:grid-cols-3 lg:grid-cols-5" />
  {:else if !other.length}
    <p class="text-sm text-dark-2">
      {anyHidden ? 'No item in this dataset can be shown here.' : 'No media found in the dataset.'}
    </p>
  {/if}
  {#if other.length}
    <ul class="mt-3 flex flex-col gap-1 text-sm">
      {#each other as item (item.index)}
        <li>
          <a href={itemUrl(item.index)} target="_blank" rel="noreferrer" class={LINK_CLASS}>
            {label(item)} (not previewable — open) ↗
          </a>
          <span class="text-dark-2"> — {item.caption ?? '(no caption)'}</span>
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

<p class="mb-3 text-xs text-dark-2">
  {plural(items.length, 'item')}{unserved
    ? `, ${unserved} of which ${unserved === 1 ? 'is not a stored upload' : 'are not stored uploads'} and cannot be shown`
    : ''}.
</p>

{#await itemStates}
  <p class="text-sm text-dark-2">Checking which dataset items can be viewed…</p>
{:then states}
  {@const blocked = stored.filter((item) => states[item.index] === 'blocked')}
  {@const unavailable = stored.filter((item) => states[item.index] === 'unavailable')}
  {@const unchecked = stored.filter((item) => states[item.index] === 'unchecked')}

  {#if blocked.length}
    <div class="mb-4 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
      <p>
        {plural(blocked.length, 'item')} in this dataset {blocked.length === 1 ? 'was' : 'were'}
        <strong>blocked by screening — not viewable here</strong>. A dataset carrying blocked items
        weighs toward <strong>Deny</strong>: approving trains on material nobody here has seen.
      </p>
      <ul class="mt-2 flex flex-col gap-1">
        {#each blocked as item (item.index)}
          <li>
            {label(item)} — blocked by screening — not viewable here
            <span class="text-dark-2"> · {item.caption ?? '(no caption)'}</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  {#if unavailable.length}
    <p class="mb-3 text-sm text-amber-200">
      {plural(unavailable.length, 'item')} could not be served (missing, or not yet scanned):
      {unavailable.map(label).join(', ')}.
    </p>
  {/if}
  {#if unchecked.length}
    <p class="mb-3 text-sm text-amber-200">
      {plural(unchecked.length, 'item')} could not be checked (no answer in time, or the orchestrator
      was busy or refused) and {unchecked.length === 1 ? 'is' : 'are'} shown unchecked — a broken tile
      may be a blocked item, which weighs toward Deny. Reload to try again; if it persists, report it.
    </p>
  {/if}

  {@render shown(states, unserved + blocked.length + unavailable.length > 0)}
{:catch}
  <p class="mb-3 text-sm text-amber-200">
    Could not check which items were blocked by screening, so a blocked item below shows as a broken
    tile — treat one as blocked, which weighs toward Deny.
  </p>
  {@render shown({}, unserved > 0)}
{/await}
